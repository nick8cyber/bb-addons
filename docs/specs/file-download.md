---
title: File Download — скачивание файлов через браузер/PWA по клику на ссылку
status: approved
owner: coordinator
date: 2026-11-22
tags: [bb, plugins, files, download, pwa]
---

# File Download — скачивание файлов из веб-версии bb

## 1. Запрос владельца

Агенты дают ссылки на файлы в треде; в веб-версии и PWA файл открывается только в предпросмотре — скачать его нельзя никак. Требуется: нажал на ссылку файла → запустилось настоящее скачивание браузером, при этом предпросмотр остаётся.

Изучение бандла 0.49.0 показало: нативная кнопка Download в `FilePreview` есть в коде, но рендерится условно — только когда хост передаёт `download`-проп, который завязан на capability `nativeDownloads` handshake'а. Серверная сборка это поле не отдаёт, поэтому в веб-клиенте кнопка никогда не появляется. Внешний плагин `hxy91819/bb-plugins:file-download` реальной загрузки не реализует (его компонент — `return <Original/>`).

## 2. Поведение

Плагин `file-download`, пакет `bb-plugin-file-download`, живёт в `plugins/bb-plugin-file-download`. Только фронтенд (`bb.app`), серверной части нет: чтение идёт через `useSdk()` — авторизация наследуется от сессии пользователя, отдельный HTTP-роут и токены не нужны.

| Действие | Результат |
|---|---|
| Клик по ссылке на файл покрытого расширения (markdown-рендер, пикер файлов, `bb thread open`) | Открывается вкладка файла: плашка с кнопкой «Скачать» + обычный предпросмотр |
| Кнопка «Скачать» в плашке | Загрузка файла браузером (`experimental_saveFile`); повторное нажатие — повторная загрузка |
| ПКМ по ссылке → «Open with → Download» | Та же вкладка для одноразового открытия |
| Файл `.pdf`, браузер со встроенным viewer (`navigator.pdfViewerEnabled`) | Вместо карточки «can't be previewed» — настоящее превью страниц в `<iframe>` с blob-URL (Chrome на десктопе). Байты читаются один раз — тот же Blob обслуживает и «Скачать» |
| `.pdf` в браузере без встроенного viewer (мобильный Chrome, часть WebView) | Обычная карточка `Original` + плашка «Скачать» |

### 2.1a. PDF-превью

У bb нет PDF-рендера (превью покрывает image/video/текст/код), поэтому `.pdf` получал лишь карточку «can't be previewed». Плагин для `*.pdf` на клиенте с `navigator.pdfViewerEnabled === true` читает байты через `readSourceFile`, создаёт `URL.createObjectURL` и рендерит `<iframe src>` — браузерный PDF viewer показывает страницы внутри вкладки bb. Пока байты грузятся — «Загрузка превью…»; ошибка чтения — текст в плашке + `Original` снизу. Без viewer — `Original` (мобильный Chrome iframe-PDF не рендерит). Blob кэшируется: «Скачать» не перечитывает файл. HTML-файлы bb умеет сам (свой sandboxed iframe) — плагин их не трогает.

### 2.1. Без автозагрузки

Автоматического скачивания при открытии нет — слово владельца 17.11: открытие предпросмотра не должно качать файл; загрузка только по явному нажатию «Скачать». Автовариант с гейтом `userActivation` был опробован и отклонён: открытие вкладки само является жестой, поэтому гейт не отличал «открыть посмотреть» от «скачать».

### 2.2. Покрытые расширения

Список статический в коде плагина — документы и артефакты, которые агенты «отдают на руки»:

`md, txt, pdf, csv, tsv, json, jsonl, xml, yaml, yml, toml, ini, log, patch, diff, zip, tar, gz, tgz, bz2, xz, 7z, rar, xlsx, xls, docx, doc, pptx, ppt, png, jpg, jpeg, gif, webp, svg, bmp, ico, mp3, wav, ogg, flac, mp4, webm, mov, html, htm, ics`

Расширения исходного кода (`ts, py, go, …`) не покрываются: их открывают ради просмотра/редактирования, лишняя загрузка при каждом открытии — мусор. Для непокрытого файла путь — «Open with → Download» недоступен (слот фильтрует по расширению); расширение списка — правкой кода.

### 2.3. Разрешение байтов по `source.kind`

| `source.kind` | Вызов SDK |
|---|---|
| `workspace` | `sdk.projects.fileContent({ projectId, environmentId?, hostId?, path })` — `path` относительно worktree. Если `source.projectId` пуст (непроектный воркспейс) — `sdk.environments.get(environmentId)` добирает `projectId`; у среды без проекта — `files.read` по `env.path + path` |
| `host` | `sdk.files.read({ hostId?, path })` — `path` абсолютный на хосте треда |
| `thread-storage` | `sdk.threads.storageLocation({ threadId })` → `{ hostId, storageRootPath }`, затем `sdk.files.read({ hostId, path: storageRootPath + "/" + path })` |

Все ответы дают `{ content, contentEncoding: "base64"|"utf8", mimeType?, sizeBytes }`. Из них собирается `Blob` (`base64` → бинарные байты, `utf8` → текст, `type = mimeType || "application/octet-stream"`) и передаётся в `app.experimental_saveFile({ fileName, blob })` — собственный download-путь bb: в браузере и Desktop — обычная загрузка, в iOS-приложении — share sheet. `fileName` — basename пути.

### 2.4. Ошибки и отказ

- Файл не читается (удалён, нет `projectId`/`threadId`, хост оффлайн) — в плашке текст ошибки, предпросмотр `Original` всё равно рендерится.
- `experimental_saveFile` вернул `failed` — bb сам показывает тост; плашка дополнительно помечается.
- Предпросмотр git-ref-снапшотов слотом не подменяется (ограничение платформы) — там Download не появляется.
- Файлы на удалённых хостах читаются через тот же `files.read` с `hostId` — требуется онлайн-демон хоста.

## 3. Устройство

- `app.tsx` — `definePluginApp`, регистрация `app.slots.fileOpener({ id: "download", title: "Download", extensions, component })` и сам компонент: плашка (имя, размер, состояние, кнопка-якорь с `href=blob-URL` + `download`) над `<Original/>`.
- `src/resolve.ts` — чистые функции: разрешение `{content, contentEncoding, mimeType}` по `source`, сборка `Blob`, basename. Тестируются моком sdk.
- Настроек плагина нет. HTTP-роутов нет — байты не покидают авторизованную сессию, произвольные пути хоста недостижимы извне.

## 4. Проверка

- [x] Юнит-тесты `src/resolve.ts`: три `source.kind`, base64/utf8 → Blob, basename, ошибки разрешения — 13/13.
- [x] `tsc --noEmit`, `bb plugin build` на SDK 0.6.132.
- [x] Плагин в реестре сервера (`running`) на обоих инстансах; байтовый путь `bb file read` подтверждён.
- [ ] Живой клик в UI (headless-браузер на хосте не стартует — первую загрузку подтверждает владелец).
- [x] Установка на инстанс Орнеллы через bb-addons-ornella-sync → `file-download@0.1.0 running` из `/opt/bb-addons-ornella`.
