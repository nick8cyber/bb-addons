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
  "ev.nameControl": "имя хука не должно содержать управляющих символов",
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
  "wd.stalled": "исполнитель завис",
  "wd.unavailable": "маршрут недоступен",
  "wd.unavailableDetail": "маршрут недоступен ({detail})",
  "wd.failed": "исполнитель завершился с ошибкой",
  "wd.failedDetail": "исполнитель завершился с ошибкой ({detail})",
  "wd.quota": "квота исполнителя исчерпана",
  "wd.quotaDetail": "квота исполнителя исчерпана ({detail})",
  "wd.stopNotConfirmed": "stop not confirmed: {cancelled}",
  "wd.cancelRetryFailed": "{outcome}: задача {task}, маршрут {route} — не удалось отменить автоповтор исполнителя ({cancelled}), перевыпуска нет, сверка повторит",
  "wd.reissueConflict": "{outcome}: задача {task}, маршрут {route} — перевыпуск за координатором: у задачи уже есть активное делегирование",
  "wd.reissued": "{outcome}: задача {task}, маршрут {route} → перевыпущено на {next}, новый тред {thread}",
  "wd.reissueRefused": "{outcome}: задача {task}, перевыпуск потерян — раздача на {next} отклонена ({error})",
  "wd.reissueFailed": "{outcome}: задача {task}, перевыпуск на {next} не удался: {error}",
  "wd.noAutoFallback": "autoFallback выключен",
  "wd.rowGone": "запись уже ушла из исхода",
  "wd.noRoute": "нет доступного маршрута в цепочке",
  "wd.reissueCoordinator": "{outcome}: задача {task}, маршрут {route} — перевыпуск за координатором ({reason})",
  "wd.stopFailed": "{outcome}: задача {task}, маршрут {route}, тред {thread} — не удалось остановить исполнителя, перевыпуск отложен, сверка повторит",
  "wd.interruptedAgain": "повторное прерывание хода ({reason})",
  "wd.resumeInterrupt": "ход прерван ({reason}), продолжай задачу",
  "wd.resumed": "ход исполнителя прерван ({reason}): задача {task}, маршрут {route}, тред {thread} — послал продолжение (resume #{n})",
  "wd.unavailableReason": "маршрут недоступен: {detail}",
  "wd.failedReport": "исполнитель завершился с ошибкой: задача {task}, маршрут {route}, тред {thread} — {error}",
  "wd.cancelledComment": "делегирование отменено: {reason} (задача {task}, маршрут {route}, тред {thread})",
  "wd.erroredAgain": "повторный обрыв хода ошибкой: {text}",
  "wd.resumeErrored": "ход оборвался ошибкой: {text}. Продолжай задачу",
  "wd.resumedErrored": "ход исполнителя оборвался ошибкой: задача {task}, маршрут {route}, тред {thread} — послал продолжение (resume #{n}). Ошибка: {text}",
  "wd.noEnv": "среда исполнителя не найдена",
  "wd.wrongBranch": "ветка {branch} вместо {expected} (ушёл в чужую ветку)",
  "wd.noCodeCommits": "задача без кода, но есть коммиты: {n}",
  "wd.noCommits": "коммитов нет",
  "wd.dirtyCopy": "копия грязная (незакоммиченные правки)",
  "wd.revived": "{task}: исполнитель {thread} поднял новый ход после исхода «{status}» — {reason}: автоповтор отменён, тред {action}",
  "wd.stopped": "остановлен",
  "wd.stopping": "останавливаю",
  "wd.newerExists": "у задачи есть более новое делегирование",
  "wd.outcomeRecorded": "исход «{status}» уже зафиксирован",
  "wd.journalCheck": "проверка журнала координатора",
  "wd.copyDirty": "грязная",
  "wd.copyClean": "чистая",
  "wd.noReport": "исполнитель закончил без отчёта",
  "wd.resultLine": "[orchestrator] {task} ({level}, тред {thread}): {status}, ветка {branch}, коммит {sha}, копия {copy}",
  "wd.doubtSuffix": ", итог сомнителен: {doubt}",
  "wd.deliverResult": "доставка итога координатору",
  "wd.verdictNudgeRelease": "заверши вердиктом: дождись проверок в этом же ходе (не фоном) и закончи строкой JSON {\"verdict\":\"APPROVE\"|\"REJECT\",\"findings\":[…]}",
  "wd.verdictNudgeReview": "заверши вердиктом: дождись проверок в этом же ходе (не фоном) и закончи строкой JSON {\"verdict\":\"OK\"|\"CHANGES\",\"blockers\":N}",
  "wd.noVerdictReason": "аудит без вердикта",
  "wd.releaseRejectedText": "аудит выкладки {task} без вердикта — выкладка отклонена",
  "wd.reviewNoVerdict": "ревью {task} без вердикта: {thread}",
  "wd.approvalWait": "исполнитель ждёт решения: задача {task}, маршрут {route}, тред {thread} — {interaction}. Реши: bb thread interactions approve|deny|grant|answer|respond {id} {thread}",
  "wd.threadArchived": "тред в архиве",
  "wd.threadDeleted": "тред удалён",
  "wd.threadNotFound": "тред не найден",
  "wd.interruptedCancel": "ход прерван (system/thread/interrupted)",
  "wd.resumeNoTurn": "продолжение не подняло новый ход",
  "wd.noFirstResponse": "нет первого ответа за {s}с",
  "wd.maxRunNotice": "делегирование #{id} дольше maxRunSeconds ({s}с): задача {task}, маршрут {route}, тред {thread} — не останавливаю",
  "wd.startNotice": "делегирование #{id}: исполнитель не начал ход за {s}с — задача {task}, маршрут {route}, тред {thread} — не останавливаю",
  "wd.idleNotice": "делегирование #{id}: нет событий ответа дольше {s}с — задача {task}, маршрут {route}, тред {thread} — не останавливаю",
  "wd.retryExhausted": "исчерпан предел повторов ({limit}): {action} по делегированию #{id} — последняя ошибка: {last}. Ручное решение: `bb orchestrator show {id}` и `bb orchestrator cancel {id}`, затем раздать заново",
  "wd.reissueDone": "перевыпуск завершён: задача {task}, маршрут {prev} → {route}, новый тред {thread}",
  "wd.finishReissue": "доведение перевыпуска",
  "wd.reissueDispatchLost": "перевыпуск потерян: задача {task}, маршрут {route} — раздача отклонена ({error})",
  "wd.dispatchNotConfirmed": "раздача не подтверждена: делегирование #{id} удалено (тред раздачи не найден)",
  "wd.attachVerify": "{task}: привязка исполнителя {thread} не подтверждена ({err}) — сверка повторяет",
  "wd.compactReminder": "[orchestrator] контекст был сжат — напоминание §3: раздача только через orchestrator_delegate; итоги исполнителей приходят сообщениями [orchestrator] — ждать в форграунде нельзя. Делегирования: {parts}. Хендофф: {handoff}",
  "wd.none": "нет",
  "wd.executorStop": "остановка исполнителя",
  "mg.noCode": "задача без кода: вливать нечего",
  "mg.dirtyResult": "исполнитель не закоммитил: копия захода грязная",
  "mg.dirtyResultHint": "доработка — новым заходом: `bb orchestrator delegate <KEY> --level <уровень>`",
  "mg.alreadyMerged": "делегирование {id} уже влито в {into} ({sha})",
  "mg.fixDelegated": "по делегированию {id} уже раздан заход разбора конфликта",
  "mg.fixDelegatedHint": "дождитесь его done и влейте его итог: `bb orchestrator merge <id захода разбора>`",
  "mg.notDoneInflight": "делегирование {id} ещё {status}, итога нет",
  "mg.notDoneFinished": "заход {id} завершился {status}, итога нет",
  "mg.prevResultHint": "прошлый итог — `bb orchestrator merge {id}`",
  "mg.notDoneHint": "merge works on finished rounds — see `bb orchestrator status`",
  "mg.notFoundMsg": "no mergeable delegation for \"{ref}\"",
  "mg.notFoundHint": "`bb orchestrator status` lists delegations; a task key resolves to its latest done delegation with a result",
  "mg.rowVanished": "делегирование {id} исчезло из хранилища",
  "mg.resultChanged": "итог делегирования {id} изменился: {fresh} ≠ записанного {sha}",
  "mg.resultChangedHint": "вливать нужно новый итог — повторите `bb orchestrator merge`",
  "mg.copyBusy": "в копии координатора незавершённая операция ({ops})",
  "mg.copyBusyHint": "завершите или отмените её (git merge|cherry-pick|revert|rebase --abort) и повторите",
  "mg.dirtyCoord": "копия координатора грязная (незакоммиченные правки)",
  "mg.dirtyCoordHint": "закоммить или уберите изменения и повторите",
  "mg.detached": "копия координатора на отсоединённом HEAD — ветки нет",
  "mg.detachedHint": "перейдите на ветку (git switch <branch>) и повторите",
  "mg.intoNotBranch": "ветка-приёмник {into} — не имя локальной ветки",
  "mg.protected": "вливание в защищённую ветку {into} запрещено",
  "mg.protectedHint": "в защищённые ветки код уходит только через `bb orchestrator release`",
  "mg.intoNotLocal": "ветка-приёмник {into} — не локальная ветка копии",
  "mg.resultMissing": "коммит итога {sha} отсутствует в репозитории копии координатора",
  "mg.resultMissingHint": "копия исполнителя и копия координатора должны быть worktree одного репозитория",
  "mg.dryRunGit": "merge --dry-run требует git ≥ 2.39 (merge-tree --write-tree)",
  "mg.foundVersion": ", найден {v}",
  "mg.versionUnread": " — `git --version` не прочитан",
  "mg.dryRunGitHint": "обновите git на машине копии",
  "mg.mergedComment": "Влито в {into} ({sha})",
  "mg.mergeHookFailed": "git merge не завершился без конфликтных файлов (отказ хука или таймаут, exit {code}): {detail}",
  "mg.notRestored": "копия координатора не вернулась в исходное состояние: {error}",
  "mg.manualFixHint": "копия {repo} — разберите вручную, там могло остаться незавершённое слияние",
  "mg.staleLock": "старая блокировка {path}: копия не возвращена к {target}: {error}",
  "mg.conflictManual": "{task}: вливание захода {round} в {into} — конфликт{files}. Разбор — вручную или новым заходом delegate (--from {sha})",
  "mg.conflictFiles": " ({files})",
  "mg.fixInstructions": "Влей {into}@{sha} в свою ветку: git merge -m \"merge {sha}\" {tip}; разреши конфликты по смыслу обеих сторон, прогони тесты, закоммить; в отчёте — какие файлы и как сведены",
  "mg.conflictFixDelegated": "{task}: вливание захода {round} в {into} — конфликт; раздан заход разбора #{id} (тред {thread})",
  "mg.conflictFixFailed": "{task}: вливание захода {round} в {into} — конфликт; автозаход разбора не раздался: {msg}",
  "mg.copyDirtyLines": "копия грязная: {lines}",
  "mg.readCopyFailed": "не удалось прочитать копию исполнителя: {error}",
  "mg.readHeadFailed": "не удалось прочитать HEAD копии исполнителя {path}: {detail}",
  "mg.staleResult": "итог захода устарел: HEAD копии исполнителя {head} ≠ записанного {sha}",
  "mg.staleResultHint": "исполнитель продолжил работу после done — дождитесь done нового захода или проверьте копию",
  "jn.attrSourceWarn": "orchestrator janitor: git < 2.40 — пометка «влито squash» недоступна (нужен --attr-source)",
  "jn.unsupportedGit": "git ≥ {maj}.{min} required (patch-id --verbatim, merge-tree --write-tree){found} — обновите git на этой машине",
  "jn.foundVersion": ", found {v}",
  "jn.versionFailed": " — `git --version` failed",
  "jn.newAbandonedCopies": "новых брошенных {n} копий: {list}",
  "jn.andMore": " и ещё {n}",
  "jn.abandonedBranches": "брошенных веток bb/ без копий: {n} — {names}",
  "jn.notify": "[orchestrator] уборщик: {parts} — разбор: bb orchestrator janitor report",
  "jn.reasonDeleted": "удалён",
  "jn.reasonArchived": "заархивирован",
  "jn.coordUnknown": "координатор неизвестен",
  "jn.coordDeleted": "координатор {id} удалён",
  "jn.lineNotDelivered": "строка координатору {id} не дошла",
  "jn.snapFailed": "снимок не удался",
  "jn.rescueNotDelivered": "{reason}{err} — {ref} {path}",
  "jn.failLine": "[orchestrator] тред {id} {reason} с несохранённой работой, снимок НЕ удался ({step}: {error}) — копия {path} уходит под уборку BB через ≤5 минут, проверь вручную",
  "jn.partialSuffix": " (снимок неполный — часть файлов не сохранилась)",
  "jn.rescueLine": "[orchestrator] исполнитель {id} {reason} с несохранённой работой{partial} — снимок: {ref}. Восстановление в новую копию: git -C {repo} worktree add {dir} {ref}^1 && git -C {dir} stash apply {ref}",
  "cli.cancelUsage": "usage: bb orchestrator cancel <delegationId|threadId>",
  "cli.mergeUsage": "usage: bb orchestrator merge <KEY|delegationId> [--into <ветка>] [--no-autofix] [--dry-run]",
  "cli.mergeNoThread": "merge works only from a bb thread (BB_THREAD_ID is absent)",
  "cli.mergeNoThreadHint": "run it inside a thread, or via the orchestrator_merge tool",
  "cli.mergeOut": "merge {task} r{round} → {into}: {verdict}",
  "cli.mergeDrySuffix": " (dry-run)",
  "cli.conflict": "конфликт ({files})",
  "cli.clean": "чисто",
  "cli.merged": "влито {sha}",
  "cli.fixDelegated": "конфликт, раздан заход разбора #{id} (тред {thread})",
  "cli.conflictClean": "конфликт, копия чистая — разбор за координатором",
  "cli.gitTooOld": "git ≥ 2.39 required — обновите git на этой машине",
  "cli.squashSuspect": " — похоже, влито squash; проверьте и удалите вручную",
  "cli.contentOnTarget": " — содержимое совпадает с целью; проверьте и удалите вручную",
  "cli.notDelivered": " — координатору не дошло",
  "cli.unknownJanitorSub": "unknown janitor subcommand \"{sub}\" (run|report)",
  "cli.unknownSub": "unknown subcommand \"{cmd}\"",
  "cli.commandsHint": "commands: delegate, status, show, cancel, merge, policy, instructions, reconcile, janitor",
  "app.role": "Роль",
  "app.roleOrchestrator": "Оркестратор",
  "app.roleExecutor": "Исполнитель",
  "app.roleAuditor": "Аудитор",
  "role.body.orchestrator": "Ты — оркестратор. Твоя роль — раздавать работу исполнителям, а не выполнять её самому.\n\n- Составную задачу не делай сам: декомпозируй её в задачи bb tasks со спеками и раздавай исполнителям через orchestrator_delegate (bb orchestrator delegate <KEY> --level <уровень>).\n- Уровень выбирай по сложности; сомневаешься — бери выше, сложное не понижай.\n- После раздачи заканчивай ход: итог исполнителя придёт сам — сообщением [bb system] … completed от BB или строкой [orchestrator] (исход, ветка, sha7, копия, отчёт), ждать в форграунде нельзя.\n- Результат исполнителя проверяй сам, прежде чем сводить и отчитываться.\n- Ревью спек до раздачи и результата после — на уровне {review} (роль auditor).\n- Сведение и выкладка результата — только твоя зона: исполнители сдают работу тебе.\n- Хендофф: веди файл HANDOFF.md в хранилище своего треда ({handoff}) — цель, решения пользователя, что сделано (ветки, SHA, задачи), что в работе и что дальше; со ссылками на треды исполнителей и их задачи. Обновляй после каждого значимого шага и до того, как контекст заполнится; после сжатия контекста или перезапуска первым делом прочитай его. Нет $BB_THREAD_STORAGE у провайдера — ~/.cache/bb-handoff/<id треда>.md, не в рабочей копии.\n- Доработку раздавай новым delegate той же задачи: плагин сам продолжит работу с коммита прошлого захода (--from <sha|ветка> — своя точка, --fresh — заново).\n- Ветку и рабочую копию исполнителя не открывай в других копиях: итог захода снимает плагин.\n- Свои поллеры поверх сторожа не ставь: исходы (зависание, квота, падение, перевыпуск) приходят сообщениями [orchestrator].\n- Не раздавай вручную (bb tasks dispatch, bb thread spawn) — только delegate.",
  "role.body.executor": "Ты — исполнитель. Твоя роль — выполнить поставленную задачу самостоятельно.\n\n- Задачу делаешь ты: субагентов не запускай и работу не перераздавай.\n- Делай строго по спеке задачи; расхождение со спекой — вопрос координатору, а не самодеятельность.\n- Правила работы с git — раздел «Работа с git» в инструкциях задачи.\n- Отчёт — по контракту из описания задачи.\n- Хендофф: веди файл HANDOFF.md в хранилище своего треда ({handoff}) — цель, решения пользователя, что сделано (ветки, SHA, задачи), что в работе и что дальше. Обновляй после каждого значимого шага и до того, как контекст заполнится; после сжатия контекста или перезапуска первым делом прочитай его. Нет $BB_THREAD_STORAGE у провайдера — ~/.cache/bb-handoff/<id треда>.md, не в рабочей копии.",
  "role.body.auditor": "Ты — аудитор. Твоя роль — только читать и проверять, ничего не меняя.\n\n- Не правь файлы, не коммить, не запускай раздачу и субагентов.\n- Проверяй по контракту: документация проекта — источник истины, код сверяй с ней.\n- Формат находок: место (файл:строки) → проблема → исправление. Без находок — явный вердикт «замечаний нет».\n- Разделяй факты и оценки; сомнительное помечай, а не выдавай за факт.\n- Отчёт — список находок или «замечаний нет»; изменений в репозитории быть не должно.",
  // Примеры ниже экранированы (\u002f, \u0061): правила скана §4
  // (vless-uri, github-token) ловят голый литерал схемы/префикса в
  // исходнике — выкладка самого плагина падала на этой строке; в
  // рантайме текст прежний.
  "role.body.releaseAuditor": "Ты — проверяющий агент выкладки (release-auditor). Твоя роль — только читать и проверять выпуск перед публикацией, ничего не меняя.\n\n- Не правь файлы, не коммить, не пушь, не запускай раздачу и субагентов. Все проверки — только чтением.\n- Вход аудита — файл, указанный в задаче: дифф выкладки, сообщения и метаданные коммитов, список связанных документов, находки машинного скана.\n- Проверь два блока:\n  1. Документация актуальна: каждое изменение поведения в коде отражено в связанных спеках, ADR и документации; нет противоречий «код ↔ спека»; ревизии и даты обновлены. Если указан явный отказ от правки документов (флаг --no-docs с причиной, трейлер Docs-not-needed) — оцени, обоснована ли причина.\n  2. Утечки всех категорий: секреты (токены, ключи, .env, VPN-конфиги, ссылки vless:\u002f\u002f), личность автора (личная почта, чужие подписи и трейлеры ботов), привязка к машине (абсолютные пути, имена хостов, внутренние IP), идентификаторы bb (thr_/proj_/env_/*.getbb.app в коде и документах; трейлер BB-Thread: в сообщении коммита разрешён), смысловые (имена людей, описание личной инфраструктуры, приватные переписки).\n- Находки не содержат значений секретов: значение маскируй (например ghp_\u0061bc123 → ghp_…***), иначе находка сама становится утечкой.\n- Итог — ОДНО сообщение строгим JSON без пояснений вокруг:\n  {\"verdict\":\"APPROVE\"|\"REJECT\",\"findings\":[{\"category\":\"docs|secrets|identity|machine|bbIds|semantic\",\"file\":\"<path>\",\"line\":<n>,\"problem\":\"<что>\",\"fix\":\"<как исправить>\"}]}\n  APPROVE — только когда находок нет. Любой другой формат будет засчитан как REJECT.",
  "role.mand.orchestrator": "- Машину вне рабочих копий не меняй: ни sudo, ни установки пакетов, ни настроек хоста — чего-то не хватает, сообщи пользователю (он и есть координатор этого чата).",
  "role.mand.executor": "- Машину вне своей рабочей копии не меняй: ни sudo, ни установки пакетов — чего-то не хватает, сообщи координатору, не делай сам.",
  "role.mand.auditor": "Заканчивай отчёт строкой JSON {\"verdict\":\"OK\"|\"CHANGES\",\"blockers\":<число блокирующих находок>} — её читает конвейер выкладки.",
  "pp.reviewSweepError": "orchestrator release: досмотр {task}: {error}",
};
