# bb-plugin-orchestrator

Policy-driven delegation of `bb tasks` to executor threads (spec:
`docs/specs/orchestrator.md`, ADR-0015).

## What it does

- **Policy** (`policy` setting, multiline JSON): levels with route chains
  over `bb tasks` presets, `maxActive`/`perLevel` limits, quota groups.
  Empty or invalid — the plugin reports `needs-configuration` and
  `delegate` refuses calls.
- **`delegate`** (agent tool `orchestrator_delegate` + CLI): one call that
  checks limits, records the delegation as `dispatching` (partial unique
  index against double dispatch), spawns the executor itself
  (`threads.spawn` with the coordinator parent, `hidden`,
  `parentNotifications=auto` and the `pluginMetadata.delegationId` label
  at creation — no `ownership-assigned` wakeup; `bb tasks dispatch`
  survives only as a fallback for a schema refusal on the own-spawn
  fields), attaches the task (`bb tasks attach`), best-effort
  `mode=bypass` for `permissionMode=full` presets, marks `running`, and
  comments «Раздано» on the task. `--no-code` (tool `noCode`) marks a
  delegation that expects no commits (§4.1 r28): the executor is told to
  report only — the §2.2 git memo's commit/branch/SHA requirements are
  left out (r28.1); the watchdog drops «коммитов нет» and flags commits
  that appear anyway; the mark rides watchdog reissues only (a new
  `delegate` without the flag is an ordinary dispatch), shows as
  `no-code` in `status`/`show`, and makes `merge`/`release` refuse
  «задача без кода: вливать нечего» when the last round produced no
  commits (r28.1).
- **Coordinator gating**: the `orchestrator_*` tools and the routing rule
  reach only threads whose role may delegate (`delegates`, §13);
  `delegate` re-checks the caller at call time (`not-a-coordinator`).
- **Watchdog** (background service, §5): first-response window
  (`firstResponseSeconds`) → `stalled` + stop; quota detection
  (`errorInfo.category`, then text patterns) → `quota`, 15-minute
  `route_holds` on the quota group; a removed model (`thread.start
  failed` before the first turn, `model not found` patterns) →
  `unavailable`: `stalled`, 15-minute hold on the route itself, no stop —
  the executor never ran; `done`/`cancelled`/`failed`/`approval`/
  `timeout` outcomes; auto-reissue down the level chain when
  `autoFallback` allows (one transaction, `reissue_of`, reuses the §4
  dispatch steps); coordinator messages via `threads.send`
  `queue-if-active` prefixed `[orchestrator]`, task comments throughout.
- **`merge`** (agent tool `orchestrator_merge` + CLI, §14): merges a
  finished round's `result_sha` into the coordinator's worktree after the
  §14 checks (clean result, clean coordinator copy, non-protected target,
  fresh executor HEAD per §16.2, one merge per copy). A conflict aborts
  back to a clean copy; with the `mergeAutofix` setting on, a fix round is
  delegated to the same task and level. Protected branches refuse —
  `release` owns them.
- **`release`** (CLI `bb orchestrator release <KEY>`, spec
  orchestrator-release §17.3): the only path code takes to a remote —
  приёмка (включая гейт ревью по публикуемым SHA) → branch sync →
  project checks → machine leak scan (every commit's patch, §16.6) →
  audit agent → publish (`push` or `pr`) → post-check.
  A merged round publishes its `merged_into` branch from the
  coordinator's copy; anything else the executor's branch.
  **Review gate (§17.3 Б4):** the branch being published must be
  reviewed — an executor branch's tip must equal the reviewed
  `result_sha`; commits above it refuse with `unreviewed-commits`
  (the pipeline's own sync-merge/docs-trailer commits, recorded in the
  release row, do not count). On a `merged_into` branch an OK review
  bound to the branch TIP covers everything below (coordinator docs
  included); without one, every merged delegation whose `merged_sha`
  is on the tip but not yet published needs its own OK review, and no
  commit may remain unexplained. Re-review a new tip with
  `bb orchestrator delegate <KEY> --level <аудит> --from <sha>` —
  `--from <merged_sha>` binds the review to a merged result.
  **Shared hooks (§17.3 Б2):** `hooks/install.mjs` sets a global
  `core.hooksPath` and installs a wrapper under every `githooks(5)`
  name EXCEPT `push-to-checkout` — its mere presence disables git's
  built-in worktree update on `receive.denyCurrentBranch=updateInstead`;
  the installer removes a wrapper an older install left under that
  name. The same shadowing works the other way too: while a global
  `core.hooksPath` is set git reads hooks ONLY from it, so a
  repository's own `.git/hooks/push-to-checkout` never fires anyway —
  keeping the name in the wrapper set would buy nothing. `pre-push` is the orchestrator gate; the rest are copies of
  `chain`, which execs the repo's own `.git/hooks/<name>` — only when
  it is executable, like git itself. The shared `pre-push` is a
  **forgetfulness guard, not a hard gate**: it stops an accidental
  `git push` via a one-time `push-token-*.json` binding branch+sha,
  but an agent running as the same user could write the token itself —
  for a hard gate use branch protection on the hosting (required
  checks); `orchestrator-setup` offers it. The installer takes the
  token dir from `bb orchestrator hooks-dir` (the plugin's data dir)
  — override with `--hooks-dir`; with neither a flag nor a working
  `bb` it refuses with a hint rather than guessing a path. A foreign
  global `core.hooksPath` refuses BEFORE any file is copied. After a
  plugin update re-run `hooks/install.mjs` — `release` refuses
  `hook-stale` when any expected wrapper is missing, differs from the
  plugin's, or a retired `push-to-checkout` wrapper is left over.
  `threadIds` (default on) allows the thread-id marker in the PR body
  from the `prBody` template (default `BB-Thread: {thread}` /
  `BB-Task: {task}`) and exempts `thr_…` from the bb-ids leak rule;
  off — `prBody` is not applied, the body is empty, and every
  `thr_…` is a `leaks.bbIds` finding (see «Тело PR»).
  `allowedTrailers` / `allowedEmails` (§17.3 С6) exempt matching
  commit trailers (e.g. `Co-Authored-By`) and e-mail addresses/domains
  from the machine scan's `foreign-bot-trailer` / `personal-email`
  rules.
  The settings project (release spec §6 r8) is the bb project of the
  executor copy's repository, resolved once at step 1 and stored in the
  release row (`settings_project_id`); any resolver error refuses
  (`release-settings-unknown` / `release-settings-ambiguous`). Test
  fixtures for leak paths live in `tests/fixtures/leak-samples.ts`
  (listed in `leaks.allow`), negative samples use `/home/example/`.
  **Deterministic outcome (§2 r10):** one release at a time per
  repository+target (guarded by the release row's `repo_root`), one
  outcome line per release — success, post-check findings and the
  postPublish result fold into it. The line is stored in the release
  row (`notice_text`) before it is sent and kept until delivered
  (`notified_at`): a pump retry only resends the stored text — it never
  reruns the post-check, postPublish, or `automation create`. A gone
  coordinator thread is not an eternal retry: the text lands as a task
  comment and the notice is confirmed. The audit has
  30 minutes from its first dispatch; a reviewer or the auditor ending
  a turn without a verdict gets ONE reminder, a second verdict-less
  turn ends the round without OK (the auditor's release is rejected
  «аудит без вердикта»). For `pr` targets the pump checks the PR through `prProvider`
  (`gh pr view` for `github`, `view` for `command`; `none` — no
  tracking) every `timing.prPollMinutes` (5): merged → «PR влит» +
  task done, closed → one line + `timing.prReopenWatchHours` (72 h)
  for a reopen-merge, open `timing.prStaleHours` (72 h) → one
  «PR висит 72 ч» line, `timing.prErrorLimit` (3) provider failures
  in a row → one «слежение невозможно» line.
  `postPublish` (`{checkout, branch?, reloadPlugins}`) fast-forwards a
  configured checkout after push and reloads the changed plugins —
  dirs with a changed manifest need `npm ci`, providers with running
  turns are postponed, and the orchestrator plugin reloads itself via
  a one-shot script automation (it cannot reload itself).
- **Reconcile** (§7): on service start and every 60 s — re-reads threads
  and events after `last_seq`, finishes half-done §4.4–4.6 steps, relinks
  `dispatching` rows by the `pluginMetadata.delegationId` label under the
  coordinator (`threads.list` + title/createdAt fallback — candidates
  labelled with another delegation's id are skipped; `bb tasks threads`
  is the last resort for every row: fallback rows and pre-r30 rows
  without the label) or drops them, survives restarts without duplicate
  reissues.
  `bb orchestrator reconcile` runs a pass immediately.
- **CLI**: `delegate`, `status`, `show`, `cancel`, `merge`, `policy show|validate`,
  `instructions`, `reconcile`.

## Роли

Three built-in roles (§13.1): `orchestrator` (the default, the only one
with `delegates: true`), `executor`, `auditor`. A role is its instruction
text plus the plugin tools and skills the thread may use.

- **Picker**: the new-chat window gets a «Роль» dropdown
  (`composer.customize`, new-thread area); the current pick is stored per
  project in `pending_roles`.
- **Decision**: the `message.dispatch` hook decides the role once, on the
  thread's first message, and writes it to `thread_roles` — the source of
  truth (`pluginMetadata.role` is display-only). Threads the hook never
  saw fall back to the §3 criterion: no parent and no executor markers →
  coordinator.
- **Limitations** (§13.2 п.5, §13.3): the plugin grants and withholds only
  its own tools — provider built-ins (file edits, shell) stay governed by
  the preset's permission mode. The role's instruction reaches the agent
  only if the provider delivers BB instructions; on a provider that does
  not, the role carries no text (agy on the ACP bridge delivers it; `acp-devin`
  restores instructions after compaction via `provider-devin`).

## Настройка

No bundled model sets — setup is a walkthrough the agent runs with the
user via the `orchestrator-setup` skill (§2.1): inventory the providers,
map presets onto levels and fallback chains, write the policy, validate.

- `policy` (multiline JSON, §2) — levels, route chains, limits, quota
  groups. Empty or invalid → `needs-configuration`, `delegate` refuses.
- `gitInstructions` (§2.2, ≤ 1500 chars) — the «Работа с git» section
  prepended to every dispatch's instructions (the spawn prompt's
  «Additional instructions»); empty disables it.
- `injectInstructions` (default on) — off silences every plugin-generated
  text; tools and `orchestrator-setup` stay.
- `needs-configuration` clears only on plugin reload (SDK V1): after
  fixing a setting run `bb plugin reload orchestrator`.

## Переход с ручной раздачи

Per §8: while manual dispatch instructions are still in place, keep
`injectInstructions = false` so the plugin's rule does not duplicate
them. The switch itself is a separate coordinator step after acceptance:
own policy via `orchestrator-setup`, `injectInstructions = true`, manual
dispatch instructions off; an external watchdog may stay as a safety net
until switched off on purpose. Plugin dispatches never need the external
watchdog — it would risk a double reissue.

## Notes

- Warnings about missing presets appear in the log, `policy show`, and
  `policy validate`; the check runs at validate/first delegate/in the
  background — never synchronously at plugin load.
- **Coordinator skills**: `orchestrator-coordinator` (full coordinator
  playbook, §3) and `orchestrator-setup` (§2.1) ship in `skills/` —
  setup always, coordinator only when `injectInstructions` is on.

## Уборщик: восстановление

Перед каждым удалением уборщик записывает SHA удаляемого в базу
(`janitor_items.tip_sha`) и строку в журнал плагина
(`removed branch|copy <репозиторий>:<ветка> at <sha>`; для копии — ещё
её HEAD); `bb orchestrator janitor run`/`report --json` выводят их.
Вернуть удалённую ветку:

```
git -C <репозиторий> branch <ветка> <sha>
```

Восстановление работает, пока `git gc` не убрал объекты — ориентировочно
две недели (стандартный `gc.pruneExpire`). После — ни ветку, ни копию
не вернуть.

Незакоммиченное в грязной копии исполнителя спасается снимком
(`refs/orchestrator/rescue/<тред>[-<N>]`) и при архиве треда, и при его
удалении — в окне ~5 минут до уборки среды BB; каждая попытка пишется в
таблицу спасений и видна в `bb orchestrator janitor report` (в т. ч.
когда строка координатору не дошла).

## Настройка под свой процесс

После выкладки `release` может выполнить шаги `postPublish`: обновить
настроенную копию, запустить команды через общий запускатель (журнал
`command_runs`), перезагрузить плагины. Полная схема —
`docs/specs/orchestrator-release.md` §6 и `docs/specs/orchestrator.md`
§18; здесь — частые примеры.

> Все команды из этой настройки **исполняет сам плагин с правами BB**.
> Каждый запуск пишется в журнал (argv, cwd, вывод до 300 символов с
> маскировкой секретов) и идёт списком аргументов без shell — `sh -c`
> используется только если вы сами так записали команду. Маскировка —
> страховка от типовых утечек (токены, пароли в URL), а не гарантия:
> секрет в нестандартном виде останется в журнале — не печатайте их.
> Изменение исполняемых полей (`eventHooks`, `postPublish.commands`,
> `checks`, `prProvider` с типом `command`) фиксируется снимком
> доверия и сообщается координаторам с незавершённой работой — не
> включайте хуки и postPublish для настроек, которым не доверяете.
> Хуки и команды выполняются от пользователя BB: агент с доступом к
> shell (и к `bb` CLI) может изменить эти настройки — давать агентам
> shell значит доверять им это.

### Плагин в корне репозитория

`checkout` — любой каталог, не обязательно `…/plugins/<id>`:
перезагружаются плагины, чей `rootDir` в реестре лежит внутри копии и у
которых изменились файлы. `checkout` можно опустить — тогда выполняются
только команды.

```json
{
  "projects": {
    "proj_repo": {
      "postPublish": {
        "checkout": "/home/example/bb-addons",
        "branch": "main",
        "reloadPlugins": true
      }
    }
  }
}
```

### Своё действие после выкладки

`commands` — список `{name, run | command, cwd, timeoutSec, when,
stopOnFail, installsDeps}`: `run` — argv-массив без shell (схема §18.2),
`command` — строка `sh -c`, если shell нужен явно. `cwd: "checkout"` —
каталог копии, иначе путь (относительный — от каталога репозитория);
по умолчанию — `checkout`, если он настроен, иначе основной каталог
репозитория. В env уходят
`ORCH_EVENT` (`release.published` | `pr.merged`), `ORCH_TASK`,
`ORCH_SHA`, `ORCH_BRANCH`, `ORCH_TARGET`, `ORCH_REPO_DIR`:

```json
"postPublish": {
  "on": "published",
  "commands": [
    { "name": "deploy", "run": ["/home/example/deploy.sh", "main"],
      "timeoutSec": 600, "stopOnFail": true },
    { "name": "docs", "command": "mkdocs build",
      "when": ["docs/**", "mkdocs.yml"] }
  ]
}
```

`when` — glob (`*`, `?`, `**`), хотя бы один патч против изменённых
выкладкой путей; `stopOnFail` — падение обязательной команды пропускает
все поздние; `installsDeps` — успешная команда снимает с плагинов
пропуск «изменены зависимости — переустанови вручную».

### GitLab и другие PR-провайдеры

`prProvider` задаётся в слоях `defaults`/`projects`; объект проекта
заменяет объект `defaults` целиком, без слияния по ключам — в отличие
от `timing` и `leaks`. Выбирает, чем открывается и досматривается PR
(§18.3):

- `{ "type": "github" }` — по умолчанию; работает через `gh`. На шаге 1
  выкладки, до аудита, проверяется `gh auth status`.
- `{ "type": "command", "create": [...], "view": [...], "find": [...]? }` —
  свои исполняемые файлы (argv без shell). `create` и `view` обязательны и
  проверяются на шаге 1: файла нет или он не исполняемый — выкладка
  отказывает до аудита. `find` необязателен.
- `{ "type": "none" }` — ветка публикуется, PR не открывается и не
  отслеживается: строка «ветка опубликована …; PR открой вручную»,
  задача `in_review`. `postPublish.on: "merged"` при `none` не сработает
  никогда — настройка предупреждает об этом при чтении.

Контракт `command` (каталог запуска — основной каталог репозитория,
таймаут `timing.prCommandTimeoutSec`): команды провайдера идут тем же
запускателем, что `postPublish.commands` — каждая в своей группе
процессов, по таймауту группе шлётся SIGTERM, затем SIGKILL, так что
зависшая обёртка не подвешивает выкладку и слежение. `create` получает
`ORCH_BRANCH`, `ORCH_TARGET`, `ORCH_TITLE` и тело PR в stdin, печатает
URL (`https?://…` — первая такая строка); ненулевой код — отказ, даже
если URL напечатан. URL с учётными данными (`user:pass@`) — отказ
«PR не открыт: URL с учётными данными», в записи и строки он не
попадает. `view` получает `ORCH_PR_URL`, печатает JSON
`{"state":"OPEN"|"MERGED"|"CLOSED","mergeCommit":"<sha>"|null}`.
`find` получает `ORCH_BRANCH`, `ORCH_TARGET`, печатает URL открытого PR
ветки или пусто; без `find` повторная выкладка задачи переиспользует
`pr_url` прошлой выкладки этой задачи и ветки этим же координатором,
если `view` отвечает `OPEN`. Весь вывод провайдера в строках
координатору проходит ту же очистку и маскировку секретов, что вывод
команд.

GitLab через `command` (пример со скриптами-обёртками над `glab`):

```json
"defaults": {
  "target": { "action": "pr", "branch": "main" },
  "prProvider": {
    "type": "command",
    "create": ["/home/example/tools/mr-create.sh"],
    "view": ["/home/example/tools/mr-view.sh"],
    "find": ["/home/example/tools/mr-find.sh"]
  }
}
```

```sh
# /home/example/tools/mr-view.sh — печатает JSON для слежения
glab mr view "$ORCH_PR_URL" -F json | jq '{
  state: (if .state == "merged" then "MERGED"
          elif .state == "closed" then "CLOSED" else "OPEN" end),
  mergeCommit: .merge_commit_sha }'
```

### Тело PR и заметка в базу знаний

`prBody` (слоёно, по умолчанию `BB-Thread: {thread}\n\nBB-Task: {task}`)
— шаблон тела PR с подстановками `{thread}`, `{task}`, `{title}`. При
`threadIds: false` шаблон не применяется — тело пустое (id треда и ключ
задачи не публикуются, §16.6). Разбор «чей PR» при повторной выкладке —
по маркеру в теле; разбираются только два маркера: `BB-Thread: thr_…`
и прежний «Источник: bb тред thr_…». Свой шаблон с `{thread}` в другом
виде («Thread: {thread}») разбираемого маркера не создаёт — тогда, как
и при `threadIds: false`, «свой PR» определяется по своим записям о
прошлых выкладках этой задачи этим координатором; чужой PR не
трогается (§18.3).

`requireNote` (по умолчанию `false`) при `true` делает `--kb <заметка>`
или `--no-kb <причина>` обязательными: шаг 1 выкладки без одного из
флагов отказывает «нужна заметка: --kb … или --no-kb …».

### Хук в чат

```json
"postPublish": {
  "on": "merged",
  "commands": [
    { "name": "chat",
      "command": "curl -sf -X POST https://chat.example.com/hooks/rel -d '{\"text\":\"released\"}'" }
  ]
}
```

### Хуки событий (`eventHooks`)

Хуки — отдельная настройка плагина `eventHooks` (уровня плагина, не
документа `release`; имя `hooks` занято git-хуками): реакция на
события конвейера, не только на выкладку. Каждое событие пишется в
таблицу `events` в той же транзакции, что и породивший его переход, и
там же сопоставляется с действующими хуками — хук, добавленный или
переименованный после события, по нему не запускается. История до
миграции событий не порождает.

```json
[
  {
    "name": "chat",
    "on": ["release.published", "pr.merged"],
    "run": ["/home/example/tools/notify-chat.sh"],
    "timeoutSec": 120,
    "notifyOnFail": true
  },
  {
    "name": "stalled-watch",
    "on": ["delegation.stalled"],
    "run": ["/home/example/tools/stalled.sh"],
    "projects": ["proj_repo"]
  }
]
```

Поля хука: `on` — виды событий; `run` — argv без shell (каталог
запуска — каталог данных плагина; свой каталог задавайте в команде);
`projects` — необязательный фильтр по проекту события; `timeoutSec` —
120 по умолчанию; `notifyOnFail` — по умолчанию `false`, при `true`
плагин шлёт координатору одну строку «хук name на событие упал:
итог» на серию сбоев — следующая только после успешного запуска этого
хука.

События v1: `delegation.done` (все уровни, включая ревью; кроме
`release-audit` — его исход это события выкладки), `delegation.failed`,
`delegation.stalled` (`reason`: `stalled`/`quota`), `review.verdict`
(делегирование ревью с прочитанным вердиктом — один раз на
делегирование; `verdict`, `blockers`), `release.published`,
`release.rejected`, `release.failed`, `pr.merged`, `pr.closed`.
Оживлённый тред (`done` → `running` → `done`) порождает
`delegation.done` повторно — с новым id события; пишите хуки
идемпотентными по `delegationId`, если это важно.

Хук получает JSON события v1 в stdin — `{ "version": 1, "event",
"at", "task", "project", "coordinatorThreadId", "delegationId"?,
"level"?, "route"?, "threadId"?, "reason"?, "verdict"?, "blockers"?,
"releaseId"?, "sha"?, "branch"?, "target"?, "prUrl"? }` — и окружение
`ORCH_EVENT`, `ORCH_TASK`, `ORCH_PROJECT`. У событий делегирования
`project` — проект делегирования; у событий выкладки и PR — проект
настройки выкладки (`settings_project_id`), с ним же сравнивается
`projects` хука. Запуск — общим запускателем (журнал `command_runs`,
`source: "hook"`), записи `events` и журнала хранятся `retentionDays`
дней (30).

### Таймауты

`timing` в слоях `release` (defaults + projects, слияние по ключам):
`auditTimeoutMinutes` (30), `checksMinutes` (10), `prepareMinutes`
(20), `prPollMinutes` (5), `prStaleHours` (72), `prReopenWatchHours`
(72), `prErrorLimit` (3), `prCommandTimeoutSec` (60),
`commandTimeoutSec` (300), `postPublishWaitMinutes` (30 — срок
только на ожидание: замок копии, очередь команд, удержание
перезагрузки; запущенную команду ограничивает её `timeoutSec`).
Таймауты сторожа — `policy.timing`:
`quotaHoldMinutes` (15), `approvalRepeatMinutes` (10),
`postDispatchGraceMinutes` (5), `bbNotifyWaitSeconds` (120). Значения
вне пределов — предупреждение и дефолт, не ошибка конфига.

## Ограничения

- **Исполнители на другой машине не поддержаны.** Итог захода
  (`result_sha`, `result_commits`, `result_dirty`), `merge` и спасение
  грязной копии читают worktree локальным `git -C` — среда исполнителя
  должна жить на том же хосте, что и сервер bb с плагином.
- **Без `/proc` уборщик ничего не удаляет.** Проверка «в копии нет
  живого процесса» (§15 п.5) читает `/proc/<pid>/cwd`; на системе без
  `/proc` (например macOS) каждая копия остаётся `process-unknown` —
  прогоны работают, но ничего не снимается.
- **Git ≥ 2.39.** Ниже — `patch-id --verbatim` не существует: уборщик
  отказывает прогон, а `merge --dry-run` — с подсказкой обновить git
  (`merge-tree --write-tree` — с 2.38).

## Development

```
npm install
npm test               # node --test (strip-types)
npm run typecheck
bb plugin build .
```
