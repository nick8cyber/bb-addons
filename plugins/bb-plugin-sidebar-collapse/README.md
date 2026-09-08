# bb-plugin-sidebar-collapse

Плагин для bb, заменяющий прокручиваемый список тредов в левом сайдбаре своим списком со свёрткой чатов сверх лимита (поведение сайдбара Claude).

В каждом проекте отображаются первые N чатов (по умолчанию 5), а остальные скрываются под кнопкой **Show more (N)**. При нажатии список раскрывается полностью, а кнопка переключается на **Show less**.

## Возможности

- **Свёртка чатов проекта**: ограничение числа одновременно видимых строк с кнопкой «Show more (N)» / «Show less».
- **Сворачивание проектов**: шеврон у названия проекта позволяет скрыть весь список тредов проекта.
- **Действия с тредами**:
  - Открытие треда обычным кликом с закрытием мобильного меню (`onNavigate`).
  - Открытие в сплите по `Cmd+клик` / `Ctrl+клик` (если сплит доступен).
  - Индикатор состояния (`waiting-for-input`, `unread-error`, фоновые агенты и др.).
  - Индикатор закрепления (`Pin`).
  - Отображение имени ветки git-окружения (`GitBranch`).
  - Подсветка активного треда (`aria-current="page"`).
  - Инлайн-переименование по двойному клику на заголовок или через меню (Enter сохраняет, Esc или blur отменяют).
  - Контекстное меню (правый клик) и меню кнопки действий (`MoreHorizontal`):
    - `Open in split`
    - `Pin` / `Unpin`
    - `Mark as read` / `Mark as unread`
    - `Rename`
    - `Archive`
    - `Delete` (destructive)
- **Клавиатурные шорткаты**: соблюдение DOM-контракта bb (`a[data-sidebar-thread-shortcut-target][data-sidebar-thread-id]`, `tabIndex={0}`, `button[aria-expanded]`).
- **Корректная деградация**: при ошибке загрузки данных плагин плавно отображает родной список хоста (`<Original />`).

## Настройки

Настройки объявляются в `server.ts` и редактируются через настройки bb или CLI:

- `visibleThreads` (`number`, по умолчанию `5`): сколько чатов проекта видно до нажатия «Show more». Значение `0` показывает все треды без свёртки.
- `keepAttention` (`boolean`, по умолчанию `true`): не скрывать под «Show more» чаты, которые ждут ответа или завершились с ошибкой.

Настройка через CLI:

```bash
bb plugin config sidebar-collapse
bb plugin config sidebar-collapse set visibleThreads 10
bb plugin reload sidebar-collapse
```

## Структура файлов

- `app.tsx` — фронтенд плагина, регистрирует слот `slots.experimental_threadList` (`id: "collapsed"`).
- `server.ts` — бэкенд плагина, объявляет настройки `visibleThreads` и `keepAttention`.
- `lib/thread-groups.ts` — модуль группировки тредов по проектам и вычисления видимых строк.
- `app.test.tsx` — набор тестов поведения списка на `@get-bb/plugin-sdk/testing/app`.

## Разработка и тесты

```bash
npm install
npx tsc --noEmit
npx vitest run app.test.tsx
```
