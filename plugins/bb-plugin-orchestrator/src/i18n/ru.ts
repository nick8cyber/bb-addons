/**
 * orchestrator §18.1 (PLUG-247a): the `ru` catalog — the historical
 * texts verbatim; spec-mandated phrasing («ровно такими») lives here.
 */
export const RU: Record<string, string> = {
  // ── instructions.ts ───────────────────────────────────────────────
  "instr.ruleHeader":
    "Раздача работы исполнителям — только через `bb orchestrator delegate <KEY> --level <уровень>` " +
    "(инструмент orchestrator_delegate). `--route` — любой маршрут политики, `--preset` — разовый пресет вне неё. " +
    "Полный порядок — навык `orchestrator-coordinator-ru`. " +
    "Отчёт исполнителя придёт сообщением — не жди его в форграунде.",
  "instr.ruleFooter":
    "Не раздавай исполнителям вручную (`bb tasks dispatch`, `bb thread spawn`) — только delegate.",
  "instr.tagReleasePipeline": " (только конвейер release, не раздавать)",
  "instr.tagAuditor": " (проверка — только чтение)",
  "instr.reviewByLevel":
    "Ревью по сложности исполнения: {pairs} " +
    "— `delegate --level review` выберет уровень сам.",
  "instr.limitActive": "одновременно активных ≤ {n}",
  "instr.limits": "Лимиты: {parts}.",
  "instr.levelsHeader": "Уровни:",
  "instr.setupHint":
    "Плагин orchestrator: политика не настроена или невалидна — delegate отклонит вызовы. " +
    "Настройка — навык `orchestrator-setup-ru`, затем `bb orchestrator policy validate`.",
  "instr.gitDefault": `Работа с git:
- Первым шагом: git fetch origin и перенос базовой ветки (git merge --ff-only origin/<база>); не вышло — вопрос координатору.
- Работай только в своей рабочей копии и своей ветке; не переключай чужие ветки и не трогай основной чекаут.
- Коммить под автором из конфига репозитория: без --author и git -c user.*; автор не задан — не коммить, напиши в отчёте.
- Без push и PR: локальный коммит, в отчёте ветка и SHA.
- Не запускай git reset --hard, git clean, git checkout -- и другие команды, теряющие чужую работу.
- Обход гейтов запрещён: никаких --no-verify, -c core.hooksPath=…, --author и записи core.hooksPath через git config (в любой области).`,
  "instr.gitTooLong":
    "gitInstructions длиннее {max} символов ({len})",
  "instr.round":
    "Заход {round}: продолжение работы с коммита {continueFrom}" +
    " (ветка {prev} прошлого захода).\n" +
    "- Первым шагом: git merge --ff-only {continueFrom}; не fast-forward —" +
    " git merge -m \"{mergeMsg}\" {continueFrom}; конфликт — вопрос координатору.\n" +
    "- Ветку прошлого захода не открывай и в её рабочую копию не заходи:" +
    " работай только в своей ветке.",
  "instr.reviewRound": "Проверяемый итог: коммит {from}{tail}",
  "instr.reviewBranch": "ветка {branch}",
  "instr.reviewRoundN": "заход {round}",
  "instr.noCode":
    "задача без кода: файлы репозитория не менять, не коммитить; итог — отчёт",

  // ── commands.ts ───────────────────────────────────────────────────
  "cmd.badSpec": "битая спецификация: {error}",
  "cmd.interruptedRestart": "прервана перезапуском",
  "cmd.interruptedStop": "остановка плагина",
  "cmd.skippedSetting": "настройка сменилась",

  // ── events.ts ─────────────────────────────────────────────────────
  "ev.notJson": "не JSON: {error}",
  "ev.expectArray": "ожидается массив хуков",
  "ev.hookObject": "хук — объект",
  "ev.nameString": "имя хука — строка",
  "ev.nameUnique": "имя хука должно быть уникальным",
  "ev.onArray": "on — непустой массив имён событий",
  "ev.runArray": "run — непустой массив argv (без shell)",
  "ev.projectsArray": "projects — массив id проектов",
  "ev.timeoutInt": "timeoutSec — целое 1…3600",
  "ev.notifyBoolean": "notifyOnFail — boolean",
  "ev.hookFailed": "хук {name} на {event} упал: {outcome}",
  "ev.eventFallback": "событие",

  // ── trust.ts ──────────────────────────────────────────────────────
  "trust.cfgBroken":
    "release-конфиг не парсится — эта часть снимка " +
    "исполняемых настроек не сверялась (прежние ключи сохранены)",
  "trust.hooksBroken":
    "eventHooks не парсится — хуки не запускаются; " +
    "в снимке доверия — маркер битого документа",
  "trust.changed": "изменены исполняемые настройки: {names}",

  // ── scan.ts ───────────────────────────────────────────────────────
  "scan.secretFile": "добавлен файл секрета (.env, ключ, id_*)",
  "scan.possibleSecret": "возможный секрет ({rule}): {text}",
  "scan.personalEmail": "личная почта в тексте",
  "scan.machine": "привязка к машине ({rule}): {text}",
  "scan.bbId": "идентификатор bb ({rule})",
  "scan.commitSig": "коммит {sha}: подпись {sig}{why}",
  "scan.sigMismatch": " не совпадает с разрешённой {name} <{email}>",
  "scan.sigRepoUnset":
    " — в конфиге репозитория не задан user.name/user.email",
  "scan.sigInvalid": " — commitIdentity не удалось разобрать",
  "scan.sigUnset": " — commitIdentity не задан в настройке release",
  "scan.botTrailer": "коммит {sha}: трейлер чужого бота ({trailers})",
  "scan.commitMachine":
    "коммит {sha}: привязка к машине в сообщении ({rule})",
  "scan.commitHost": "коммит {sha}: имя хоста в сообщении",
  "scan.commitBbId": "коммит {sha}: идентификатор bb в сообщении ({rule})",
  "scan.commitEmail": "коммит {sha}: личная почта в сообщении",
  "scan.gitleaksMissing":
    "gitleaks не установлен — машинный скан категории 1 невозможен",
  "scan.gitleaksMissingHint":
    "установите gitleaks (https://github.com/gitleaks/gitleaks) и повторите release",
  "scan.gitleaksExit": "gitleaks завершился с ошибкой (exit {code}): {out}",
  "scan.gitleaksReport": "gitleaks вернул нечитаемый отчёт: {text}",
  "scan.secretRule": "секрет ({rule})",
  "scan.cat1": "секреты",
  "scan.cat2": "личность автора",
  "scan.cat3": "привязка к машине",
  "scan.cat4": "идентификаторы bb",
  "scan.commitsWord": "коммиты",

  // ── roles.ts ──────────────────────────────────────────────────────
  "role.handoffOneLine": "handoffPath должен быть одной строкой",
  "role.handoffTooLong":
    "handoffPath длиннее {max} символов ({len})",
  "role.badJson": "невалидный JSON: {error}",
  "role.notObject": "roleTexts должен быть JSON-объектом",
  "role.badKeys":
    "ключи — только orchestrator|executor|auditor " +
    "(release-auditor не переопределяется)",
  "role.mustBeString": "must be a string",
  "role.tooLong": "итог длиннее {max} символов",
  "role.textsError": "roleTexts: {path}: {message}",

  // ── delegate.ts ───────────────────────────────────────────────────
  "del.notCoordinator":
    "thread {threadId} is not a coordinator (has a parent or executor markers)",
  "del.notCoordinatorHint":
    "delegate is only available to coordinator threads",
  "del.taskNotFound": "cannot resolve task \"{input}\": {error}",
  "del.taskNoKey": "cannot resolve task \"{input}\" to a key",
  "del.policyInvalid": "policy is not usable: {detail}",
  "del.policyInvalidHint":
    "fix it via `bb plugin config orchestrator set policy …`, then `bb orchestrator policy validate`",
  "del.routePresetConflict": "--route and --preset cannot be combined",
  "del.routePresetHint":
    "--route names a policy route; --preset dispatches a one-off existing preset",
  "del.fromFreshConflict": "--from and --fresh cannot be combined",
  "del.fromFreshHint":
    "--from names the commit to continue from; --fresh starts the round from the base",
  "del.levelForbidden":
    "--level release-audit назначает только конвейер выкладки",
  "del.levelForbiddenHint":
    "раздавай уровни исполнения и ревью из политики",
  "del.levelNote":
    "review → {mapped} по сложности исполнения {level}",
  "del.unknownLevel": "level \"{level}\" is not in the policy",
  "del.unknownLevelHint": "levels: {levels}",
  "del.unknownPreset": "preset \"{preset}\": {error}",
  "del.presetNoProvider":
    "preset \"{preset}\" has no providerId in bb tasks preset show",
  "del.routeHeld": "provider quota group \"{group}\" is on hold",
  "del.routeHeldHint":
    "wait for the hold to expire or pick a preset on another provider",
  "del.limitActive": "active delegations {count}/{max}",
  "del.limitActiveHint":
    "wait for an active delegation to finish or raise limits.maxActive",
  "del.limitLevel": "active \"{level}\" delegations {count}/{max}",
  "del.taskDelegated": "task {taskKey} already has an active executor",
  "del.taskDelegatedHint":
    "use `bb orchestrator status` / `bb orchestrator cancel` first",
  "del.holdReason": "маршрут недоступен: {text}",
  "del.routeHeldNote":
    "{text} — маршрут {route} отмечен недоступным на 15 минут",
  "del.dispatchRefused": "раздача на {route} отклонена: {detail}",
  "del.dispatchUnknown": "результат раздачи неизвестен ({detail})",
  "del.dispatchUnclean":
    "dispatch did not answer cleanly: exit {code}",
  "del.dispatchUnknownHint":
    "the delegation stays `dispatching`; the reconcile pass will link the thread or remove the record",
  "del.ownSpawnUnavailable": "свой запуск недоступен: {error}",
  "del.noThreadId":
    "delegation {id} has no thread_id for the setup steps",
  "del.leftDispatching":
    "delegation left 'dispatching' before step 6 (now '{status}')",
  "del.dispatchAfterSpawn": "dispatch failed after spawn: {error}",
  "del.comment":
    "Раздано: {note}, маршрут {route}, пресет {preset}, тред {threadId}",
  "del.levelWord": "уровень {level}",
  "del.spawnRefused": "spawn refused{code}: {reason}",
  "del.spawnNoId": "threads.spawn returned no thread id",

  // ── release.ts ──────────────────────────────────────────────────────
  "rel.gitFailed": "git {cmd} failed (exit {code}): {out}",
  "rel.noOutput": "no output",
  "rel.settingsUnknown":
    "проект настройки не определён ({why}); проект делегирования {delegation}",
  "rel.settingsUnknownHint":
    "привяжите bb-проект к репозиторию копии (§6) и повторите",
  "rel.worktreeListFailed": "git worktree list завершился с кодом {code}",
  "rel.projectListFailed": "bb project list завершился с кодом {code}",
  "rel.projectListJson": "bb project list вернул JSON неожиданной формы",
  "rel.realpathFailed": "realpath основного каталога копии не удался",
  "rel.remoteUrlFailed": "git remote get-url завершился с кодом {code}",
  "rel.settingsAmbiguous":
    "репозиторий копии совпадает с несколькими bb-проектами ({list}), " +
    "проект делегирования {delegation} не среди них",
  "rel.settingsAmbiguousHint":
    "оставьте один bb-проект на этот репозиторий (§6) и повторите",
  "rel.settingsNoMatch": "ни один bb-проект не совпал с репозиторием копии",
  "rel.missingNoDone": "нет делегирования в статусе done",
  "rel.noCode": "release {key}: задача без кода: вливать нечего",
  "rel.missingNoSha":
    "итог делегирования без зафиксированного sha — ревью не привязать",
  "rel.missingNoReview":
    "нет ревью аудиторского уровня на публикуемый итог {sha7}",
  "rel.missingReviewStatus":
    "ревью на {sha7} (уровень {level}) в статусе {status}",
  "rel.verdictMissing":
    "вердикт ревью не найден ни в комментариях, ни в итоге треда",
  "rel.verdictNotOk": "последнее ревью — вердикт не «OK» (§16.7 JSON)",
  "rel.missingNotCoordinator":
    "вызывающий тред — не координатор этого делегирования",
  "rel.acceptFailed": "release {key}: приёмка не пройдена — {missing}",
  "rel.dirty":
    "в рабочей копии есть незакоммиченные изменения — release отклонён",
  "rel.dirtyHint": "закоммить или убрать изменения и повторить",
  "rel.syncCommitsExtra":
    "release {taskKey}: во время sync на ветку {branch} легли коммиты " +
    "сверх проверенной вершины {sha7}: {list}",
  "rel.syncCommitsHead":
    "release {taskKey}: во время sync на ветку {branch} легли коммиты " +
    "сверх проверенной вершины {sha7} (вершина {head})",
  "rel.syncCommitsHint":
    "ревью покрывает вершину на момент гейта — повторите release, когда " +
    "исполнитель остановлен",
  "rel.stopHint": "повторите release, когда исполнитель остановлен",
  "rel.checksCommitsHint":
    "ревью покрывает вершину после sync — повторите release, когда " +
    "исполнитель остановлен",
  "rel.branchPushed": "ветка {branch} уже запушена — sync=rebase запрещён",
  "rel.branchPushedHint":
    'переведите проект на sync="merge" или заведите новую ветку',
  "rel.rebaseConflict": "rebase на {target}: конфликт — сведи вручную",
  "rel.rebaseForeign":
    "release {taskKey}: после rebase на ветке {branch} коммиты вне " +
    "проверенного диапазона: {list}",
  "rel.mergeConflict": "merge {target}: конфликт — сведи вручную",
  "rel.checksCommitsDuring":
    "release {taskKey}: во время проверок на ветку {branch} легли " +
    "коммиты сверх проверенной вершины: {list}",
  "rel.checksCommitsAfter":
    "release {taskKey}: после проверок на ветку {branch} легли " +
    "коммиты сверх проверенной вершины: {list}",
  "rel.trailerForeign":
    "release {taskKey}: во время записи трейлера на ветку {branch} " +
    "легли чужие коммиты (вершина {head})",
  "rel.checkFailed":
    "проверка проекта упала: {check} (exit {code})\n{tail}",
  "rel.docsTrailerCommit": "release: документы не требуются",
  "rel.verdictUnparsableProblem":
    "ответ проверяющего агента не парсится как строгий JSON",
  "rel.verdictUnparsableFix": "перезапустить аудит или проверить вручную",
  "rel.hookMissingWrappers": "нет обёрток: {missing}",
  "rel.hookStale":
    "установленные общие хуки устарели или неполные ({problems})",
  "rel.hookStaleHint":
    "переустановите хуки: node {installPath} --hooks-dir {hooksDir}",
  "rel.disabled": "настройка release не задана",
  "rel.disabledHint":
    "задайте `bb plugin config orchestrator set release '<json>'` (§6)",
  "rel.cfgInvalid": "release config: {detail}",
  "rel.cfgInvalidHint":
    "исправьте настройку `release` и выполните `bb plugin reload orchestrator`",
  "rel.auditLevelMissing": 'уровень "{level}" не задан в политике',
  "rel.auditLevelMissingHint":
    "добавьте уровень release-audit с цепочкой маршрутов в policy (§3)",
  "rel.inProgress": "по задаче {taskKey} уже идёт выкладка",
  "rel.mergedNoBranch":
    "делегирование помечено merged, но ветка merged_into не записана",
  "rel.mergedNoCopy":
    "итог влит в копию координатора, но у вызывающего треда нет рабочей копии",
  "rel.noExecThread":
    "у делегирования нет треда исполнителя — рабочая копия не найдена",
  "rel.noCopy":
    "у исполнителя нет рабочей копии (environmentPath/environmentBranchName пусты)",
  "rel.execTurn":
    "release {taskKey}: у треда исполнителя идёт ход — его новые коммиты " +
    "не покрыты ревью итога",
  "rel.execTurnHint": "дождитесь завершения хода исполнителя и повторите",
  "rel.excluded":
    "проект настройки {project} исключён из release (excluded: true); " +
    "проект делегирования {delegation}",
  "rel.requireNote":
    "release {taskKey}: нужна заметка: --kb <заметка> или --no-kb <причина>",
  "rel.copyBusy": "в копии координатора незавершённая операция ({ops})",
  "rel.copyBusyHint":
    "завершите или отмените её (git merge|cherry-pick|revert|rebase --abort) и повторите",
  "rel.copyDirty": "копия координатора грязная (незакоммиченные правки)",
  "rel.copyDirtyHint": "закоммить или уберите изменения и повторите",
  "rel.detached": "копия координатора на отсоединённом HEAD — ветки нет",
  "rel.detachedHint": "перейдите на ветку (git switch <branch>) и повторите",
  "rel.copyNotRestored":
    "копия координатора не вернулась в исходное состояние: {error}",
  "rel.copyNotRestoredHint":
    "копия {repo} — разберите вручную, там могло остаться незавершённое слияние",
  "rel.resultMissing":
    "release {taskKey}: итог делегирования {sha7} отсутствует в копии {repo}",
  "rel.unreviewed":
    "release {taskKey}: ветка {branch} содержит коммиты сверх проверенного " +
    "итога {sha7}: {list}",
  "rel.unreviewedHint":
    "верните ветку к result_sha или раздайте ревью на новый итог",
  "rel.mergeCommitMissing":
    "release {taskKey}: коммит слияния {sha7} ({key}) отсутствует в копии {repo}",
  "rel.mergeCommitMissingHint":
    "восстановите коммит слияния или поправьте запись merge",
  "rel.foreignCommits":
    "release {taskKey}: в диапазоне {branch} коммиты без влитого " +
    "делегирования: {list}",
  "rel.foreignCommitsHint":
    "ревью всей вершины покрывает их: bb orchestrator delegate {taskKey} " +
    "--level <уровень аудита> --from {tip}",
  "rel.noMergedReview": "release {taskKey}: нет ревью на влитый итог {label}",
  "rel.mergedReviewHint":
    "раздайте ревью на влитый итог: bb orchestrator delegate {key} " +
    "--level <уровень аудита> --from {sha}",
  "rel.mergedReviewStatus":
    "release {taskKey}: ревью на {label} в статусе {status}",
  "rel.mergedReviewVerdict":
    "release {taskKey}: вердикт ревью на {label} {word}",
  "rel.verdictMissingWord": "не найден",
  "rel.verdictNotOkWord": "не «OK»",
  "rel.prevPublishedMissing":
    "release {taskKey}: прошлая опубликованная вершина {sha8} отсутствует " +
    "в копии {repo}",
  "rel.prevPublishedMissingHint":
    "новый заход продолжает от published_sha — повторите из копии, где " +
    "этот коммит есть",
  "rel.notFastForward":
    "ветка публикации не fast-forward от {sha8} — новый заход должен " +
    "продолжать от published_sha",
  "rel.scanBlockers":
    "release {taskKey}: машинный скан нашёл {n} блокирующих находок:\n{list}",
  "rel.auditInstr":
    "Выкладка задачи {taskKey}: аудит релиза (шаг 5 конвейера). " +
    "Вход аудита — файл {packet}, прочитай его целиком. " +
    "Репозиторий для проверки: {repo} (коммит {sha} — проверяй его, " +
    "ветка копии после выкладки может отличаться). " +
    "Итог — ОДНО сообщение строгим JSON " +
    '{\"verdict\":\"APPROVE\"|\"REJECT\",\"findings\":[…]} без пояснений; ' +
    "находки — без значений секретов (маскируй).",
  "rel.stoppedBeforeAudit": "выкладка остановилась до раздачи аудита",
  "rel.stoppedBeforeAuditNotice":
    "выкладка {taskKey} остановлена до раздачи аудита — повторите release",
  "rel.auditTimeout": "аудит не завершился за {min} мин",
  "rel.auditTimeoutNotice":
    "выкладка {taskKey} остановлена: аудит не завершился за {min} мин — " +
    "повторите release",
  "rel.auditOutcome": "аудит завершился исходом {status}",
  "rel.auditOutcomeNotice":
    "выкладка {taskKey} остановлена: проверяющий агент завершился исходом " +
    "{status} — {why}",
  "rel.auditCancelled": "аудит отменён, выкладки нет",
  "rel.auditExhausted": "цепочка {level} исчерпана, выкладки нет",
  "rel.rejectReasonUnparsable": "ответ аудитора не парсится",
  "rel.rejectUnparsableSuffix": " (ответ не парсится)",
  "rel.rejectNotice": "аудит выкладки {taskKey}: REJECT{unp}\n{list}",
  "rel.noFindings": "- без находок в ответе",
  "rel.publishFailed": "выкладка {taskKey} упала на публикации: {error}",
  "rel.selfReloadManual": "\nперезагрузи orchestrator вручную: {error}",
  "rel.selfReloadUnconfirmed":
    "\nперезагрузи orchestrator вручную: автоматизация не подтверждена",
  "rel.prMerged": "PR влит {taskKey}: {url}{sha}",
  "rel.prMergedSha": " → {sha7}",
  "rel.prWatchImpossible": "слежение за PR {taskKey} невозможно: {error}",
  "rel.prClosed": "PR закрыт без влития {taskKey}: {url}",
  "rel.prStale": "PR висит {hours} ч {taskKey}: {url}",
  "rel.viewNoCmd": "command.view не задан",
  "rel.viewExit": "command.view завершился с кодом {code}: {tail}",
  "rel.viewNotJson": "command.view: ответ не JSON: {out}",
  "rel.viewBadState": "command.view: неожиданный state: {state}",
  "rel.viewNone": "провайдер сменился на none — слежение невозможно",
  "rel.ghViewNotJson": "gh pr view: ответ не JSON: {out}",
  "rel.ghViewBadState": "gh pr view: неожиданный state: {state}",
  "rel.prUnavailable": "провайдер PR недоступен: {why}",
  "rel.ghNotAuth": "gh нет или не авторизован (код {code}): {tail}",
  "rel.cmdNotSet": "command.{kind} не задан",
  "rel.cmdNotFound": "command.{kind}: исполняемый файл не найден: {file}",
  "rel.prCredUrl": "PR не открыт: URL с учётными данными",
  "rel.foreignPr":
    "PR {url} у ветки {branch} создан не этим release (Источник: {src}) — " +
    "release в чужую ветку PR не пишет",
  "rel.noSrc": "нет",
  "rel.findExit": "провайдер PR (find) завершился с кодом {code}: {out}",
  "rel.viewErr": "провайдер PR (view): {error}",
  "rel.prCreateExit": "PR не открыт (код {code}): {out}",
  "rel.prNoOutput": "PR не открыт: {out}",
  "rel.prNoOutputWord": "нет вывода",
  "rel.published": "выложено {taskKey}: {sha7} в {branch}; задача done",
  "rel.branchPublished":
    "ветка опубликована {taskKey}: {branch}; PR открой вручную",
  "rel.prCreated": "PR открыт {taskKey}: —; слежу до влития",
  "rel.prLine": "{word} {taskKey}: {url}; слежу до влития",
  "rel.prUpdated": "PR обновлён",
  "rel.prOpened": "PR открыт",
  "rel.kbNote": "KB-заметка: {note}",
  "rel.kbNone": "KB не требуется: {reason}",
  "rel.postCheck": "пост-проверка: {msg}",
  "rel.postCheckFail": "пост-проверка не удалась: {error}",
  "rel.selfReloadOk": "; перезагружено: orchestrator",
  "rel.selfReloadFail":
    "; orchestrator после перезагрузки не поднялся / копия на $last, " +
    "ожидался $EXPECTED",
  "rel.fetchFailed": "fetch не удался — {error}",
  "rel.landedOutside": "в {branch} легли коммиты вне release: {list}",
  "rel.notAncestor":
    "выложенный {sha8} не предок {target} (remote head {head})",
  "rel.remoteMismatch":
    "удалённая ветка {remote} указывает на {sha8}, выкладывали {sha82}",
  "rel.prNotFound": "PR ветки {branch} → {target} не найден",
  "rel.rescanNoBase":
    "скан пропущен, нет базы удалённого диапазона (первая выкладка в " +
    "новую ветку)",
  "rel.rescanEmpty": "скан пропущен, удалённый диапазон пуст",
  "rel.rescanFound":
    "повторный скан удалённого диапазона нашёл находки:\n{list}",
  "rel.rescanFailed": "повторный скан не удался: {error}",
  "packet.title": "# Аудит выкладки {taskKey}",
  "packet.task": "- Задача: {taskKey} — {title}",
  "packet.repo": "- Репозиторий (рабочая копия с итогом задачи): {repo}",
  "packet.branch": "- Ветка: {branch} → {action} в {target}",
  "packet.range": "- Диапазон: {base}..{head}",
  "packet.noDocs": "- --no-docs: {text}",
  "packet.kb": "- --kb: {text}",
  "packet.noKb": "- --no-kb: {text}",
  "packet.commits": "## Коммиты",
  "packet.docs": "## Связанные документы для проверки актуальности",
  "packet.noMap":
    "- карты нет: проверяй все документы репозитория (docs/, README*, ADR)",
  "packet.noDocsTouched": "- затронутых документов по карте нет",
  "packet.findings": "## Находки машинного скана (шаг 4)",
  "packet.none": "- нет",
  "packet.diff": "## Дифф выкладки",
  "pp.cmdOk": "{name}: ok",
  "pp.cmdNoCheckout": "{name}: нет checkout",
  "pp.cmdSkipped": "{name}: пропущена — {tail}",
  "pp.cmdTimeout": "{name}: таймаут",
  "pp.cmdInterrupted": "{name}: прервана перезапуском",
  "pp.cmdFailed": "{name}: упала (код {code}){tail}",
  "pp.noCheckout": "нет checkout",
  "pp.copyUpdated": "копия обновлена",
  "pp.copyNotUpdated": "копия не обновлена",
  "pp.skipWhen": "нет изменений по when",
  "pp.stoppedBy": "не прошла {name}",
  "pp.notWaited": "не дождались {waiting}",
  "pp.waitLock": "замка копии",
  "pp.waitQueue": "очереди команд",
  "pp.waitFinish": "завершения шагов",
  "pp.noProject": "проект настройки не определён",
  "pp.otherRepo": "другой репозиторий — не обновлена",
  "pp.wrongBranch": "копия не на {branch} — не обновлена",
  "pp.fetchFailed": "fetch не удался: {err}",
  "pp.ffFailed": "ff не прошёл ({err})",
  "pp.reloadDisabled": "перезагрузка плагинов выключена",
  "pp.depsChanged":
    "{id}: изменены зависимости — переустанови их и перезагрузи вручную",
  "pp.registryUnread":
    "{id}: реестр провайдеров не прочитан — перезагрузи вручную",
  "pp.turnsRunning": "{id}: идут ходы — перезагрузи позже",
  "pp.cmdsRunning": "orchestrator: идут команды — перезагрузи позже",
  "pp.reloadFailed": "{id}: перезагрузка не удалась: {err}",
  "pp.reloaded": "перезагружено: {list}",
  "pp.skipped": "пропущено: {list}",
  "pp.selfReloading": "orchestrator перезагружается автоматизацией",
  "pp.noChanges": "плагины не менялись",
  "store.busyTarget":
    "в цель {target} уже идёт выкладка {busyKey} — одна выкладка в цель за раз",

  // ── server.ts / hooks ───────────────────────────────────────────────
  "hook.expired":
    "push отклонён: маркер release истёк — повторите `bb orchestrator release`",
  "hook.wrongBranch":
    "push отклонён: маркер release выписан на другую ветку " +
    "({remote} ≠ ветка маркера)",
  "hook.wrongCommit":
    "push отклонён: маркер release выписан на другой коммит ({sha})",
  "hook.noToken":
    "push отклонён: выкладка только через `bb orchestrator release` " +
    "(нет одноразового маркера)",
  "status.moreErrs": " (+{n} ещё)",
  "status.fixSetting": "исправьте `{name}`",
  "status.reloadHint": " — затем `bb plugin reload orchestrator`",
  "status.execChanged": "изменённые исполняемые настройки: {names}",
  "status.noIdentity":
    "предупреждение: автор коммитов не задан (release.commitIdentity) — " +
    "подписи коммитов скан не блокирует",
  "status.noDelegations": "нет делегирований",
  "status.notifyMuted":
    " (уведомления заглушены, ждут восстановления auto)",
  "status.coordCancel": " (отменено координатором)",
  "cli.reminder": "Ответ исполнителя придёт сообщением — закончи ход.",
  "cli.noCodeDescribe":
    "Пометить делегирование «задача без кода» (§4.1 r28): исполнитель " +
    "не должен коммитить, сторож коммитов не ждёт",
  "cli.releaseUsage":
    "bb orchestrator release <KEY> [--no-docs <причина>] " +
    "[--kb <заметка>|--no-kb <причина>] [--json]",
  "cli.releaseUsageShort":
    "bb orchestrator release <KEY> [--no-docs <причина>] " +
    "[--kb <заметка>|--no-kb <причина>]",
  "cli.kbConflict": "--kb и --no-kb несовместимы",
  "cli.releaseStarted":
    "release {taskKey}: аудит запущен (release #{id}, тред {thread}; " +
    "проект настройки {settings}, проект делегирования {delegation})",
  "cli.scanWarnings": "\nпредупреждения скана:\n{list}",
  "cli.releaseReminder":
    "\nитог придёт сообщением [orchestrator] — закончи ход.\n",
  "cli.delegated":
    "раздано {taskKey}: уровень={level} маршрут={route} тред={thread} " +
    "(делегирование #{id})",
  "cli.note": "note: {note}",
  "cli.setupErrors": "setup errors: {list}",
  "cli.cancelled": "делегирование #{id} отменено",
  "cli.noDelegation": "нет делегирования {ref}",
  "cli.noDelegationHint": "смотрите `bb orchestrator status`",
  "cli.policyEmpty": "(policy пуста)",
  "cli.policyValid": "policy корректна",
  "cli.unknownPolicySub": 'неизвестная подкоманда policy "{sub}" (show|validate)',
  "cli.cannotGenerate":
    "не собрать правило раздачи без корректной политики",
  "cli.cannotGenerateHint":
    "настройте её через навык `{skill}` (§2.1), затем " +
    "`bb orchestrator policy validate`",
  "cli.noCallerThread":
    "release работает только из треда bb (BB_THREAD_ID отсутствует)",
  "cli.delegateUsage":
    "usage: bb orchestrator delegate <KEY> --level <уровень> " +
    "[--route <м>|--preset <п>] [--instructions <т>] " +
    "[--from <sha|branch>] [--fresh] [--no-code]",

  // ── policy.ts parse errors ──────────────────────────────────────────
  "pol.empty":
    "политика не задана — настройте через навык `orchestrator-setup-ru`",
  "pol.badJson": "невалидный JSON: {error}",
  "pol.notObject": "политика должна быть JSON-объектом",
  "pol.version": "version must be 1",
  "pol.routesReq": "нужен объект описаний маршрутов",
  "pol.routeObject": "маршрут должен быть объектом",
  "pol.presetReq": "нужно непустое имя пресета",
  "pol.providerReq": "нужен непустой id провайдера",
  "pol.nonEmptyString": "должна быть непустая строка",
  "pol.stringArray": "должен быть массив непустых строк",
  "pol.maxPatterns": "не больше 20 шаблонов",
  "pol.seconds30600": "должно быть число 30–600",
  "pol.numGe30": "должно быть число ≥ 30",
  "pol.numGe60": "должно быть число ≥ 60",
  "pol.levelsReq": "нужен объект описаний уровней",
  "pol.levelObject": "уровень должен быть объектом",
  "pol.isString": "должна быть строка",
  "pol.isBool": "должен быть boolean",
  "pol.roleEnum": 'должно быть "auditor" или "executor"',
  "pol.chainReq": "нужен непустой массив имён маршрутов",
  "pol.routeNameStr": "имя маршрута должно быть непустой строкой",
  "pol.routeUndeclared": 'маршрут "{route}" не объявлен в routes',
  "pol.reviewByLevelObject":
    "должен быть объект уровень → уровень ревью",
  "pol.levelUndeclared": 'уровень "{level}" не объявлен в levels',
  "pol.levelNotExecutor":
    'уровень "{level}" без роли "executor"',
  "pol.levelName": "должно быть именем уровня",
  "pol.levelNotAuditor": 'уровень "{level}" без роли "auditor"',
  "pol.isObject": "должен быть объект",
  "pol.intGe1": "должно быть целое ≥ 1",
  "pol.perLevelObject": "должен быть объект уровень → предел",
  "pol.capOverMax": "должно быть ≤ limits.maxActive ({max})",
  "pol.byProviderObject":
    "должен быть объект id провайдера → секунды",
  "pol.timingObjectIgnored":
    "должен быть объект значений сроков — игнорируется",
  "pol.outOfBoundsDefault":
    "вне пределов {min}..{max} — берётся умолчание",
  "pol.numGe300": "должно быть число ≥ 300",
  "pol.presetNotFound":
    'пресет "{preset}" не найден в bb tasks preset list',
  "pol.presetNoWorktree":
    'пресет "{preset}" не создаёт рабочую копию ' +
    "(environmentKind={kind}); уровню \"{level}\" исполнителю " +
    "нужна своя копия",

  // ── release-config.ts parse errors ──────────────────────────────────
  "rc.targetObject": "должен быть объект {action, branch}",
  "rc.actionEnum": 'должно быть "push" или "pr"',
  "rc.branchReq": "нужно непустое имя ветки",
  "rc.isObject": "должен быть объект",
  "rc.syncEnum": 'должно быть "merge" или "rebase"',
  "rc.checksArray": "должен быть массив непустых команд",
  "rc.commandNonEmpty": "должна быть непустая команда",
  "rc.isBool": "должен быть boolean",
  "rc.docsMapObject":
    "должен быть объект префикс пути → пути документов",
  "rc.docsMapPrefixes":
    "префиксы путей должны быть непустыми строками",
  "rc.docsArray":
    "должен быть массив непустых путей документов",
  "rc.leaksObject":
    "должен быть объект {machine, bbIds, trailers, allow}",
  "rc.leaksEnum": 'должно быть "block" или "warn"',
  "rc.pathsArray": "должен быть массив непустых путей",
  "rc.commitIdentity":
    'должно быть "repo" или подпись "Name <email>"',
  "rc.stringArray": "должен быть массив непустых строк",
  "rc.trailerName":
    'должно быть известным именем трейлера ("Co-Authored-By", ' +
    '"Signed-off-by", "Generated with", "Generated-by"), ' +
    'опционально ": <префикс значения>"',
  "rc.providerType": 'type должен быть "github", "command" или "none"',
  "rc.argvArray":
    "должен быть непустой массив argv из строк",
  "rc.requiredForCommand": 'обязательно для type "command"',
  "rc.ignoredForType": 'игнорируется — type "{type}"',
  "rc.templateString": "должен быть строкой-шаблоном",
  "rc.timingObject": "должен быть объект значений сроков",
  "rc.outOfBoundsDefault":
    "вне пределов {min}..{max} — берётся умолчание",
  "rc.ppObject":
    "должен быть объект {checkout?, branch?, reloadPlugins?, " +
    "on?, commands?}",
  "rc.checkoutPath": "должен быть непустой путь чекаута",
  "rc.branchNonEmpty": "должно быть непустое имя ветки",
  "rc.onEnum": 'должно быть "published" или "merged"',
  "rc.commandsArray": "должен быть массив объектов команд",
  "rc.commandObject": "должен быть объект {name, run|command, …}",
  "rc.commandNameReq": "нужно непустое имя команды",
  "rc.dupCommand": 'дубль имени команды "{name}" — пропущена',
  "rc.runReq":
    "нужен массив argv `run` (или строка `command`)",
  "rc.cwdPath": "должен быть непустой путь или `checkout`",
  "rc.timeoutBounds": "вне пределов 5..3600 — игнорируется",
  "rc.whenArray":
    "должен быть массив непустых glob-шаблонов",
  "rc.ppNeedsSomething":
    "нужен хотя бы checkout или одна команда",
  "rc.badJson": "невалидный JSON: {error}",
  "rc.notObject": "настройка release должна быть JSON-объектом",
  "rc.projectsObject":
    "должен быть объект переопределений по bb-проектам",
  "rc.projectIds": "id проектов должны быть непустыми строками",
  "rc.mergedOnPush":
    '"merged" для push-цели читается как "published"',
  "rc.mergedNever":
    '"merged" никогда не сработает — prProvider "none"',
  "rc.missingCheckout":
    '"{name}" требует отсутствующий checkout — отчитает "нет checkout"',

  // ── tool descriptions / CLI help ────────────────────────────────────
  "tool.delegate":
    "Раздать bb-задачу на тред исполнителя по политике маршрутизации " +
    "(spec: docs/specs/orchestrator.md)",
  "tool.delTaskKey": "Ключ задачи, например PLUG-129",
  "tool.delLevel": "Имя уровня из политики маршрутизации",
  "tool.delRoute":
    "Любой маршрут из политики (не только из цепочки уровня); " +
    "по умолчанию — первый доступный",
  "tool.delPreset":
    "Разовое: существующий пресет `bb tasks` вне политики. " +
    "Несовместимо с `route`",
  "tool.delInstructions": "Дополнительные инструкции только этой раздачи",
  "tool.delFrom":
    "Продолжить заход с явного sha или ветки (§6 --from)",
  "tool.delFresh":
    "Начать заход без продолжения прошлого итога (§6 --fresh)",
  "tool.status":
    "Список делегирований и счётчики этого координатора " +
    "(активные против лимитов политики).",
  "tool.statusAll": "Включить делегирования всех координаторов",
  "tool.cancel":
    "Отменить делегирование: остановить тред исполнителя и пометить " +
    "запись отменённой. Принимает id делегирования или id треда.",
  "tool.cancelTarget":
    "Id делегирования (число) или id треда исполнителя (thr_…)",
  "cli.helpSummary":
    "Раздача bb-задач на треды исполнителей по политике маршрутизации " +
    "(spec: docs/specs/orchestrator.md)",
  "cli.helpDelegateS": "Раздать задачу исполнителю по политике",
  "cli.helpStatusS": "Делегирования и счётчики",
  "cli.helpShowS": "Одно делегирование по id или id треда",
  "cli.helpCancelS":
    "Остановить исполнителя и пометить делегирование отменённым",
  "cli.helpMergeS":
    "Влить итог завершённого захода в рабочую копию координатора (§14)",
  "cli.helpPolicyS": "Показать или проверить заданную политику",
  "cli.helpInstructionsS":
    "Напечатать сгенерированное правило раздачи (§3)",
  "cli.helpReconcileS":
    "Принудительный проход сверки (стадия сторожа)",
  "cli.helpReleaseS":
    "Детерминированный конвейер выкладки " +
    "(spec orchestrator-release §2)",
  "cli.helpHooksDirS":
    "Каталог общего pre-push хука и маркеров push",
  "cli.helpJanitorS":
    "Уборщик: чистка слитых копий, веток и тредов (§15)",

  "tool.delegateInstr":
    "Используй orchestrator_delegate вместо ручных `bb tasks dispatch` " +
    "+ `bb thread update`. Ответ исполнителя придёт сообщением — " +
    "закончи ход после раздачи.",
};
