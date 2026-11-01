---
title: Русский язык результатов Advisor
status: approved
owner: coordinator
date: 2026-11-01
tags: [advisor, localization]
---

# Русский язык результатов Advisor

## 1. Проблема и границы

В growthhack-social Advisor пишет по-русски, в infra — по-английски при одной модели Claude Opus 5.5 и зарегистрированной русской инструкции. Существующий ru-плагин добавляет системную инструкцию, но Advisor отправляет английские запросы и принимает любой язык. Владелец разрешил автономно выполнить согласованный план до работающего результата.

Сохранить все локальные доработки установленного Advisor из cache/git/github.com/salemsayed/bb-plugin-advisor/bd4b6aeba3bea0bc75472be7556dc2bb8845aed8. Исходники переносятся в plugins/bb-plugin-advisor с MIT LICENSE и указанием происхождения. Не править установленный cache, core BB, маршрутизацию моделей, настройки других проектов. Идентификатор advisor, его БД, настройки, сессии и API остаются совместимыми.

## 2. Язык каждого запроса

Advisor получает собственную настройку outputLanguage: ru | auto, default ru. Ru задаёт обязательный русский язык summary/details в каждом review prompt: создание, повторное использование сессии, deadline/finalize. Auto отключает указание и проверку языка. Значение фиксируется на начало одной проверки. Ru-плагин больше не внедряет инструкцию ревьюеру: старый advisorRussian помечается устаревшим, язык теперь задаётся в Advisor. Документация обоих плагинов отражает переход.

Проверка языка применяется к summary и details отдельно. После удаления защищённых фрагментов и технических слов prose проходит, если пуста либо доля кириллических букв среди кириллических и латинских >= 60% и нет последовательности из четырёх обычных английских слов. Технические слова timeout, retry, cache, API, SDK, JSON, HTTP и идентификаторы CamelCase/snake_case/kebab-case/UPPERCASE не считаются английской прозой. Нулевой русский при оставшейся английской прозе требует перевода. Пустое details / none допустимы. Русское «Исправлен timeout при retry» проходит, «Исправлено. The function returns before state is saved» требует перевода. Эвристика и её границы документируются.

Русская инструкция явно сохраняет английские labels severity/key/summary/details/resolved, значения pass|nit|concern|blocker и literal none. Key — прежний Latin slug; resolved содержит прежние ключи, без перевода. Только значения summary/details переводятся. Маркеры ADVISOR_RESULT/END_ADVISOR_RESULT не меняются.

## 3. Ограниченная локализация ответа

После parseAdvisorOutput и до сохранения/доставки проверять русский текст. Если нужен перевод — ровно один дополнительный запрос в той же сессии Advisor с той же моделью/провайдером/окружением/permission mode. Переводится только summary/details. Новое ревью, инструменты, изменение оценки или закрытие находок запрещены. Перевод — JSON с двумя строковыми полями summary и details; дополнительные поля и невалидный JSON отклоняются.

Стабильные поля исходного AdvisorFinding (severity, key, resolved и прочие) никогда не берутся из перевода. normalized, lookup цепочки, effective severity и resolvedKeys вычисляются только из original parsed review до изменения текста. Локализуются лишь сохраняемые summary/details. Повтор английского keyless/legacy blocker как nit с другим переводом или предупреждением обязан остаться в прежней цепочке с severity blocker.

Защищённые категории: fenced и inline code; URL со scheme://; абсолютные/относительные пути с / или Windows backslash, имена file.ext и :line; двойные кавычки "..." / “...” / «...» и markdown blockquote; последовательности цифр включая десятичные/версии/:line. Одиночные кавычки не считаются цитатами: don't и it's остаются прозой. Код, URL, пути, цитаты и числа защищаются уникальными плейсхолдерами: при восстановлении обязательны исходные токены, принадлежность полю и количество, без неизвестных/потерянных/повторных токенов. Защищённый текст восстанавливается побайтово. JSON с лишними полями, неизвестными токенами или более 256 KiB отклоняется. Проверка языка выполняется повторно после восстановления.

Дополнительно перевод не может добавлять новые code/URL/path/quote/number фрагменты: после удаления известных плейсхолдеров в candidate не должно появляться новых защищённых диапазонов. Это запрещает, например, вставленную переводчиком новую команду или изменённое число при сохранении исходных токенов. При нарушении показывается оригинал с предупреждением.

Перевод ограничен отдельным timeout 30 секунд, не запускается после отмены. Abort, timeout, send/wait/output/parse failure не теряют исходное замечание: сохранить исходные summary/details, добавив в details явное русское предупреждение «Не удалось перевести ревью на русский; показан оригинал». Это не unavailable и не pass: исходная severity и цепочка замечания сохранены. Активный перевод останавливается при ошибке/отмене. Таймеры и abort listeners очищаются. Outcome помечает отмену перевода; все shared/manual/tool/auto callers исключают auto-continue/follow-up при такой отмене.

Исторические строки БД автоматически не переводятся и не переписываются. В новых проверках перевод производится до доставки, включая ручной, tool и auto review пути. Нормализация/цепочки не должны ослаблять существующие findings.

## 4. Контракт модуля языка

Исполнитель B владеет только src/language.ts и src/language.test.ts.

~~~ts
export type ReviewText = { summary: string; details: string };
export function russianReviewInstruction(): string;
export function needsRussianTranslation(review: ReviewText): boolean;
export function prepareRussianTranslation(review: ReviewText): {
  prompt: string;
  parse(output: string): ReviewText | null;
};
export function withTranslationFailureNotice(review: ReviewText): ReviewText;
~~~

Модуль чистый, без BB SDK/IO. Ошибки формата возвращают null, без бросания наружу. Случайные уникальные токены допустимы; тесты не зависят от конкретного значения. До dispatch координатор кладёт в общую базу declaration-compatible src/language.ts с заглушками, бросающими ошибку. B заменяет тела; A может мокать существующий модуль для изолированных lifecycle tests. Финальная проверка обязательно идёт на настоящем модуле B.

Исполнитель A владеет server.ts, server.test.ts, package.json/lock/build configuration, .bb/plugins.json и изменениями ru/server.ts + ru/server.test.ts. Миграция на публичный @get-bb/plugin-sdk 0.4.87 (версия ru-плагина) обязательна: убрать vendored path map/declarations/vendor tgz, переписать импорты и только необходимые test fixtures, сохранить package name bb-plugin-advisor, PLUGIN_ID advisor и presentation. Не переходить на 0.6.x: текущий BB 0.48.1 и engines.bbPluginSdk ^0.4.1. A интегрирует модуль, не меняя файлы B. Документацию пишет координатор.

## 5. Приёмка и выкладка

| Проверка | Ожидаемый результат |
|---|---|
| Новая и переиспользованная сессия ru | Каждый запрос содержит русский контракт |
| Уже русский ответ | Нет запроса перевода |
| Auto | Нет языкового контракта/перевода |
| Английский и смешанный ответ | Один ограниченный запрос, русский результат |
| Код/команды/URL/пути/цитаты/числа | Побайтовая сохранность защищённых фрагментов |
| Перевод вернул severity/key/resolved или повреждённые токены | Оригинал с предупреждением, оценка не меняется |
| Timeout/abort/send/output/parse error | Оригинал видим, нет потери замечания или утечки активной сессии |
| Severity/threshold/repeat/resolved и existing suites | Существующий жизненный цикл сохранён |
| Live BB | Ручной review idle-треда infra, где замечен английский: новая строка advisor_reviews с русской прозой в summary/details, без failure notice; не более одного дополнительного translation turn |

1. Отдельный документный коммит; одно pre-review opus55-xhigh-review проверяет эту спецификацию и задачи до исполнения.
2. Параллельно A (Gemini 3.8 High) и B (OpenCode DeepSeek Flash), каждый отдельная ветка/worktree, локальные коммиты без push/PR.
3. Координатор проверяет результаты и сводит в изолированной ветке. Один post-review opus55-xhigh-review и один advisor_review после проверки.
4. Перед сведением в main и установкой согласовать с активными агентами этого проекта. БД сохранять через sqlite3 backup API, учитывая WAL, настройки — через bb plugin config advisor. Проверить отсутствие активного review; прочитать план замены source и установить path:/home/ubuntu/work/bb/bb-addons --plugin advisor без remove/uninstall. Тот же id advisor. После установки сверить source=path, прежние settings, advisor_reviews/advisor_sessions counts и чтение старых findings. Новый outputLanguage=ru добавляется, прочие настройки неизменны.
5. npm run verify (typecheck+test+build), 83 baseline tests + новые. Live infra review по таблице выше. Сначала установить и проверить Advisor; только после успеха reload ru, чтобы при отказе установки сохранить прежнюю русскую инструкцию. Ru работает из main по path, поэтому main обновлять лишь в согласованное окно; если установка не удалась, откатить ru-файлы до reload. Ни копирование node_modules, ни vitest cache не должны писать в установленный cache: B использует node_modules из coordinator worktree. Push в bb-addons разрешён автономным поручением владельца. При невозможности безопасной установки оставить текущий плагин работающим и явно сообщить препятствие.

Уточнение установленного BB 0.48.1: assertInstallRegistrationAvailable разрешает перенос path→path, но прямо запрещает git→path для занятого id. Поддерживаемая замена в этом случае — снять прежнюю регистрацию и установить новую с тем же id. Код remove сохраняет plugin data.db и KV, но очищает settings/secrets/schedules и удаляет managed source cache. Поэтому перед заменой повторно сохранить актуальную БД через backup, original source и settings; проверить, что у Advisor нет секретов и schedules; подготовить точное восстановление всех settings. После замены сверить counts/данные и settings. При наличии секретов/schedules или невозможности восстановления не выполнять remove. При ошибке установки немедленно установить сохранённую оригинальную path-копию и восстановить настройки; data.db не откатывать к старой копии, чтобы не терять новые записи.

