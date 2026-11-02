---
title: Server Switcher по нажатию
status: accepted
updated: 2026-11-02
---

# Server Switcher по нажатию

## 1. Footer и открытие

На старте плагин регистрирует только штатный disclosure в footer. Не вызывать open() или toggle() в setup, effects, account watchers или timers. Панель открывается и закрывается штатным нажатием на её иконку; при открытии сразу показывает текущий сервер и список Switch to, без дополнительного нажатия на текущий сервер; при первом заходе и после закрытия/reload остаётся закрытой. Не заменять другую открытую footer-панель. Label Servers, disclosure id servers и pluginId server-switcher сохранить.

Footer icon — стандартный BB ComputerCloud, монохромный outline/currentColor, размер и hit area задаёт host как у соседних Settings/Usage. Server отсутствует в каталоге BB0.48.1, поэтому он не используется. Не регистрировать server-switcher-avatar как footer icon и не оставлять generic fallback. По прямому указанию владельца аватары и цветные rings внутри списка также заменяются монохромным ComputerCloud (20px), с сохранением индикатора доступности. Настройка обводок в интерфейсе не показывается; сохранённые данные и RPC остаются совместимыми. WatchAccount нужен для актуальности списка и не удаляется.

## 2. Поведение и данные

Account/browser, desktop и mobile поведение исходника сохраняется: текущий сервер, другие серверы аккаунта, offline disabled, штатные переходы и mobile read-only. Не трогать authentication, pairing, connect, server URLs, provider/model routing. server.ts, servers.ts, rings.ts, ring-store.ts, avatar-ui.tsx и vended UI менять нельзя. Сохранить storage namespace server-switcher, RPC listRings/setRing и CLI server-switcher ring, KV rings/ringsRevision. Не сбрасывать настройки или account connections.

## 3. Source package

Source in the existing bb-addons repo <bb-addons>/plugins/bb-plugin-server-switcher: baseline из исходника установленный server-switcher0.1.2 из upstream00febc4b2585d2de6d837b05bd0b25dcefccef5c. Исходная отметка UNLICENSED сохраняется. Владелец явно указал хранить форк в этом же bb-addons; отдельные проекты и репозитории не создавать. Пакет private:true не публикуется в npm. Сохранить upstream provenance/license. package name bb-plugin-server-switcher неизменен (id stable), private:true, версия0.1.3-local.1. Стандартный source-backed bb.server ./server.ts и bb.app ./app.tsx, build через bb plugin build. Зафиксировать SDK текущего BB, declared dependencies для vended UI и reproducible package-lock. Тесты существующих pure modules запускать без переписывания их семантики (vitest run). Пин backend zod; frontend runtime packages по SDK shim правилам. Не использовать приватные BB imports/кеш как runtime dependency. Исполнителям npm install разрешён только в своём worktree, без paid gateways и model changes. Dist собирает и коммитит координатор после сведения.

Зависимости упаковки: @get-bb/plugin-sdk ровно0.6.104, engines.bbPluginSdk ^0.6.104; dependencies zod4.6.7 и @radix-ui/react-slot. Type-only devDependencies react/react-dom/@types/react/@types/react-dom/@radix-ui/react-popover, версии синхронизировать bb plugin types с host. clsx^2, tailwind-merge^3, class-variance-authority^0.7 — host-shim/type-only dev. Для настоящего fake-host backend: better-sqlite3 ровно12.11.1 (npm без ignore-scripts), @types/node и Vitest/TypeScript. bb.branding.experimental_icons.bb-mark сохраняется — он нужен списку.

## 4. Приёмка

Полный typecheck, existing pure tests, build. Изолированный настоящий BB browser: desktop/mobile360/390, fresh page закрыт, icon native outline и соответствует соседним по стилю, клик открывает список, повторный клик закрывает, reload после закрытия не открывает. Offline rows не активны; тест перехода через intercepted fixture/navigation без переключения живого пользовательского сеанса; desktop/mobile mode logic покрыты existing tests. Проверить не только наличие icon name, но реально SVG (без generic fallback), посмотреть screenshot. Никаких живых изменений connections/rings для теста.

## 5. Миграция и выпуск

После PRE ОК: implementation task A только package.json/package-lock/tsconfig и test runner config; task B только app.tsx. Каждый в собственном git worktree/ветке, без push/install/доков/агентов/advisor/help. Координатор переносит commits, verify/build + browser candidate, разовый POST Opus; все находки исправить. Перед main/reload перечислить активные треды этого проекта BB Plugins и согласовать окно. Перед любой сменой регистрации координатор выполняет npm ci, full verify/build В КАНОНИЧЕСКОЙ папке <bb-addons>/plugins/bb-plugin-server-switcher (либо отдельной exact-release copy), убеждается, что JS/CSS совпадают с одобренными; это разрешённое исключение из worker-only ограничения npm. Удалить устаревшие неиспользуемые dist/install-app.mjs, install-app.css, install-server.mjs после source build; entry points только исходные server.ts/app.tsx. Backup installed source/dist/config и публичный listRings snapshot (включая revision), plugin private data backup. Заменять источник только supported bb CLI, не патчить core/cache/DB. Сначала пробовать supported path-to-path/source install без unregister. Если managed install не позволяет replace, remove допустим ТОЛЬКО при повторно подтверждённых нулевых KV/settings/schedules/secrets (текущий исходник: count0/0/0, listRings revision0/rings{}). Remove по CLI удаляет settings/secrets/schedules и managed cache; retention KV не предполагать. При ненулевых данных остановиться ДО unregister и выбрать supported migration со state snapshot, не патчить DB. После install same id сравнить settings и listRings включая revision; source cache backup физически отдельный. Rollback — локальный baseline package с проверенной SDK compatibility, restore registration через supported CLI, никогда не откатывать живую базу целиком. Никаких новых вопросов владельцу для обратимых шагов согласованной задачи. Отдельный проект или репозиторий не создавать: форк входит в bb-addons по прямому указанию владельца.

Уточнение integration: SDK0.6.104 публично зависит от zod^4.6.5. Pin4.6.7 обеспечивает единый Zod без tsconfig paths в приватные SDK node_modules. Такие paths запрещены; проверять dedupe, tsc и исходные23 теста после сведения.

Решение по прямому указанию владельца: использовать ту же папку существующего bb-addons. Локальный commit/установка разрешены, публичного push в этой задаче нет. Отдельные source/release каталоги вне bb-addons не создавать. До remove повторно читать фактические core store counts mode=ro и secrets directory, не считать ошибку disabledRPC пустотой. После enable нового — config/listRings сверить.
