/**
 * orchestrator §18.1 (PLUG-247a): the `en` string catalog. Keys are
 * namespaced by module; `{name}` marks an interpolation point. The `ru`
 * catalog keeps the exact historical texts; `en` carries their
 * translation. Machine contracts never become keys (verdict JSON,
 * error codes, field/setting names, prBody markers, journal labels).
 */
export const EN: Record<string, string> = {
  // ── instructions.ts — routing rule, git memo, round sections ───────
  "instr.ruleHeader":
    "Delegate work to executors only via `bb orchestrator delegate <KEY> --level <level>` " +
    "(the orchestrator_delegate tool). `--route` — any policy route, `--preset` — a one-off preset outside it. " +
    "The full procedure — the `orchestrator-coordinator` skill. " +
    "The executor's report arrives as a message — do not wait for it in the foreground.",
  "instr.ruleFooter":
    "Do not dispatch executors manually (`bb tasks dispatch`, `bb thread spawn`) — delegate only.",
  "instr.tagReleasePipeline": " (release pipeline only — do not delegate)",
  "instr.tagAuditor": " (review — read-only)",
  "instr.reviewByLevel":
    "Review by implementation complexity: {pairs} " +
    "— `delegate --level review` picks the level itself.",
  "instr.limitActive": "at most {n} active",
  "instr.limits": "Limits: {parts}.",
  "instr.levelsHeader": "Levels:",
  "instr.setupHint":
    "orchestrator plugin: the policy is not configured or is invalid — delegate refuses calls. " +
    "Setup — the `orchestrator-setup` skill, then `bb orchestrator policy validate`.",
  "instr.gitDefault": `Working with git:
- First step: git fetch origin and fast-forward the base branch (git merge --ff-only origin/<base>); if that fails — ask the coordinator.
- Work only in your own worktree and your own branch; do not check out other branches or touch the main checkout.
- Commit under the author configured in the repository: no --author or git -c user.*; if no author is configured — do not commit, say so in the report.
- No push and no PR: a local commit; report the branch and the SHA.
- Do not run git reset --hard, git clean, git checkout -- or other commands that lose someone else's work.
- Bypassing the gates is forbidden: no --no-verify, -c core.hooksPath=…, --author, or writing core.hooksPath through git config (in any scope).`,
  "instr.gitTooLong":
    "gitInstructions is longer than {max} characters ({len})",
  "instr.round":
    "Round {round}: continuing work from commit {continueFrom}" +
    " (branch {prev} of the previous round).\n" +
    "- First step: git merge --ff-only {continueFrom}; if not fast-forward —" +
    " git merge -m \"{mergeMsg}\" {continueFrom}; a conflict — ask the coordinator.\n" +
    "- Do not open the previous round's branch or enter its worktree:" +
    " work only in your own branch.",
  "instr.reviewRound": "Result under review: commit {from}{tail}",
  "instr.reviewBranch": "branch {branch}",
  "instr.reviewRoundN": "round {round}",
  "instr.noCode":
    "no-code task: do not change repository files, do not commit; the report is the result",

  // ── commands.ts — journal outcome tails (§18.5, PLUG-245) ─────────
  "cmd.badSpec": "bad spec: {error}",
  "cmd.interruptedRestart": "interrupted by a restart",
  "cmd.interruptedStop": "plugin shutdown",
  "cmd.skippedSetting": "settings changed",

  // ── events.ts — eventHooks parse + notifyOnFail (PLUG-246) ────────
  "ev.notJson": "not JSON: {error}",
  "ev.expectArray": "expected an array of hooks",
  "ev.hookObject": "a hook must be an object",
  "ev.nameString": "the hook name must be a string",
  "ev.nameUnique": "hook names must be unique",
  "ev.onArray": "on — a non-empty array of event names",
  "ev.runArray": "run — a non-empty argv array (no shell)",
  "ev.projectsArray": "projects — an array of project ids",
  "ev.timeoutInt": "timeoutSec — an integer 1…3600",
  "ev.notifyBoolean": "notifyOnFail — boolean",
  "ev.hookFailed": "hook {name} on {event} failed: {outcome}",
  "ev.eventFallback": "event",

  // ── trust.ts — executable-settings snapshot warnings (§18.5) ──────
  "trust.cfgBroken":
    "the release config does not parse — this part of the " +
    "executable-settings snapshot was not checked (previous keys kept)",
  "trust.hooksBroken":
    "eventHooks does not parse — hooks do not run; " +
    "the trust snapshot holds the broken-document marker",
  "trust.changed": "executable settings changed: {names}",

  // ── scan.ts — machine leak scan findings (release §4) ─────────────
  "scan.secretFile": "secret file added (.env, key, id_*)",
  "scan.possibleSecret": "possible secret ({rule}): {text}",
  "scan.personalEmail": "personal email in the text",
  "scan.machine": "machine binding ({rule}): {text}",
  "scan.bbId": "bb identifier ({rule})",
  "scan.commitSig": "commit {sha}: signature {sig}{why}",
  "scan.sigMismatch": " does not match the configured {name} <{email}>",
  "scan.sigRepoUnset":
    " — user.name/user.email is not set in the repo config",
  "scan.sigInvalid": " — commitIdentity could not be parsed",
  "scan.sigUnset": " — commitIdentity is not set in the release setting",
  "scan.botTrailer": "commit {sha}: foreign bot trailer ({trailers})",
  "scan.commitMachine":
    "commit {sha}: machine binding in the message ({rule})",
  "scan.commitHost": "commit {sha}: hostname in the message",
  "scan.commitBbId": "commit {sha}: bb identifier in the message ({rule})",
  "scan.commitEmail": "commit {sha}: personal email in the message",
  "scan.gitleaksMissing":
    "gitleaks is not installed — the category-1 machine scan is impossible",
  "scan.gitleaksMissingHint":
    "install gitleaks (https://github.com/gitleaks/gitleaks) and rerun release",
  "scan.gitleaksExit": "gitleaks failed (exit {code}): {out}",
  "scan.gitleaksReport": "gitleaks returned an unreadable report: {text}",
  "scan.secretRule": "secret ({rule})",
  "scan.cat1": "secrets",
  "scan.cat2": "author identity",
  "scan.cat3": "machine binding",
  "scan.cat4": "bb identifiers",
  "scan.commitsWord": "commits",

  // ── roles.ts — §18.6 settings validation (PLUG-249) ───────────────
  "role.handoffOneLine": "handoffPath must be a single line",
  "role.handoffTooLong":
    "handoffPath is longer than {max} characters ({len})",
  "role.badJson": "invalid JSON: {error}",
  "role.notObject": "roleTexts must be a JSON object",
  "role.badKeys":
    "keys — only orchestrator|executor|auditor " +
    "(release-auditor cannot be overridden)",
  "role.mustBeString": "must be a string",
  "role.tooLong": "the result is longer than {max} characters",
  "role.textsError": "roleTexts: {path}: {message}",

  // ── delegate.ts — dispatch checks, comments, spawn path ───────────
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
    "--level release-audit is assigned only by the release pipeline",
  "del.levelForbiddenHint":
    "delegate executor and review levels from the policy",
  "del.levelNote":
    "review → {mapped} by the implementation complexity {level}",
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
  "del.holdReason": "route unavailable: {text}",
  "del.routeHeldNote":
    "{text} — route {route} marked unavailable for 15 minutes",
  "del.dispatchRefused": "dispatch to {route} refused: {detail}",
  "del.dispatchUnknown": "the dispatch result is unknown ({detail})",
  "del.dispatchUnclean":
    "dispatch did not answer cleanly: exit {code}",
  "del.dispatchUnknownHint":
    "the delegation stays `dispatching`; the reconcile pass will link the thread or remove the record",
  "del.ownSpawnUnavailable": "own spawn unavailable: {error}",
  "del.noThreadId":
    "delegation {id} has no thread_id for the setup steps",
  "del.leftDispatching":
    "delegation left 'dispatching' before step 6 (now '{status}')",
  "del.dispatchAfterSpawn": "dispatch failed after spawn: {error}",
  "del.comment":
    "Delegated: {note}, route {route}, preset {preset}, thread {threadId}",
  "del.levelWord": "level {level}",
  "del.spawnRefused": "spawn refused{code}: {reason}",
  "del.spawnNoId": "threads.spawn returned no thread id",

  // ── release.ts ──────────────────────────────────────────────────────
  "rel.gitFailed": "git {cmd} failed (exit {code}): {out}",
  "rel.noOutput": "no output",
  "rel.settingsUnknown":
    "settings project not resolved ({why}); delegation project {delegation}",
  "rel.settingsUnknownHint":
    "bind a bb project to the copy repository (§6) and retry",
  "rel.worktreeListFailed": "git worktree list exited with code {code}",
  "rel.projectListFailed": "bb project list exited with code {code}",
  "rel.projectListJson": "bb project list returned an unexpected JSON shape",
  "rel.realpathFailed": "realpath of the copy's main directory failed",
  "rel.remoteUrlFailed": "git remote get-url exited with code {code}",
  "rel.settingsAmbiguous":
    "the copy repository matches several bb projects ({list}); " +
    "delegation project {delegation} is not among them",
  "rel.settingsAmbiguousHint":
    "leave a single bb project on this repository (§6) and retry",
  "rel.settingsNoMatch": "no bb project matched the copy repository",
  "rel.missingNoDone": "no delegation in status done",
  "rel.noCode": "release {key}: no-code task: nothing to merge",
  "rel.missingNoSha":
    "delegation result has no recorded sha — cannot bind a review",
  "rel.missingNoReview":
    "no auditor-level review on the published result {sha7}",
  "rel.missingReviewStatus":
    "review on {sha7} (level {level}) is in status {status}",
  "rel.verdictMissing":
    "review verdict found neither in comments nor in the thread result",
  "rel.verdictNotOk": "last review — verdict is not «OK» (§16.7 JSON)",
  "rel.missingNotCoordinator":
    "the calling thread is not this delegation's coordinator",
  "rel.acceptFailed": "release {key}: acceptance failed — {missing}",
  "rel.dirty":
    "the working copy has uncommitted changes — release refused",
  "rel.dirtyHint": "commit or remove the changes and retry",
  "rel.syncCommitsExtra":
    "release {taskKey}: during sync, commits landed on {branch} above " +
    "the reviewed tip {sha7}: {list}",
  "rel.syncCommitsHead":
    "release {taskKey}: during sync, commits landed on {branch} above " +
    "the reviewed tip {sha7} (tip {head})",
  "rel.syncCommitsHint":
    "the review covers the tip as of the gate — retry release once the " +
    "executor is stopped",
  "rel.stopHint": "retry release once the executor is stopped",
  "rel.checksCommitsHint":
    "the review covers the tip after sync — retry release once the " +
    "executor is stopped",
  "rel.branchPushed": "branch {branch} is already pushed — sync=rebase refused",
  "rel.branchPushedHint":
    'switch the project to sync="merge" or create a new branch',
  "rel.rebaseConflict": "rebase onto {target}: conflict — resolve manually",
  "rel.rebaseForeign":
    "release {taskKey}: after rebase, branch {branch} has commits outside " +
    "the reviewed range: {list}",
  "rel.mergeConflict": "merge {target}: conflict — resolve manually",
  "rel.checksCommitsDuring":
    "release {taskKey}: during the checks, commits landed on {branch} " +
    "above the reviewed tip: {list}",
  "rel.checksCommitsAfter":
    "release {taskKey}: after the checks, commits landed on {branch} " +
    "above the reviewed tip: {list}",
  "rel.trailerForeign":
    "release {taskKey}: while writing the trailer, foreign commits " +
    "landed on {branch} (tip {head})",
  "rel.checkFailed":
    "project check failed: {check} (exit {code})\n{tail}",
  "rel.docsTrailerCommit": "release: docs not required",
  "rel.verdictUnparsableProblem":
    "the reviewing agent's reply does not parse as strict JSON",
  "rel.verdictUnparsableFix": "rerun the audit or check manually",
  "rel.hookMissingWrappers": "missing wrappers: {missing}",
  "rel.hookStale":
    "the installed shared hooks are stale or incomplete ({problems})",
  "rel.hookStaleHint":
    "reinstall the hooks: node {installPath} --hooks-dir {hooksDir}",
  "rel.disabled": "release is not configured",
  "rel.disabledHint":
    "set `bb plugin config orchestrator set release '<json>'` (§6)",
  "rel.cfgInvalid": "release config: {detail}",
  "rel.cfgInvalidHint":
    "fix the `release` setting and run `bb plugin reload orchestrator`",
  "rel.auditLevelMissing": 'level "{level}" is not defined in the policy',
  "rel.auditLevelMissingHint":
    "add a release-audit level with a route chain to policy (§3)",
  "rel.inProgress": "a release for task {taskKey} is already running",
  "rel.mergedNoBranch":
    "the delegation is marked merged but merged_into is not recorded",
  "rel.mergedNoCopy":
    "the result is merged into the coordinator copy, but the calling " +
    "thread has no working copy",
  "rel.noExecThread":
    "the delegation has no executor thread — the working copy is not found",
  "rel.noCopy":
    "the executor has no working copy (environmentPath/environmentBranchName empty)",
  "rel.execTurn":
    "release {taskKey}: the executor thread has a turn in flight — its " +
    "new commits are not covered by the result review",
  "rel.execTurnHint": "wait for the executor's turn to finish and retry",
  "rel.excluded":
    "settings project {project} is excluded from release " +
    "(excluded: true); delegation project {delegation}",
  "rel.requireNote":
    "release {taskKey}: a note is required: --kb <note> or --no-kb <reason>",
  "rel.copyBusy":
    "the coordinator copy has an unfinished operation ({ops})",
  "rel.copyBusyHint":
    "finish or abort it (git merge|cherry-pick|revert|rebase --abort) and retry",
  "rel.copyDirty": "the coordinator copy is dirty (uncommitted edits)",
  "rel.copyDirtyHint": "commit or remove the changes and retry",
  "rel.detached": "the coordinator copy is on a detached HEAD — no branch",
  "rel.detachedHint": "switch to a branch (git switch <branch>) and retry",
  "rel.copyNotRestored":
    "the coordinator copy did not return to its original state: {error}",
  "rel.copyNotRestoredHint":
    "copy {repo} — sort it out manually; an unfinished merge may remain",
  "rel.resultMissing":
    "release {taskKey}: delegation result {sha7} is missing in copy {repo}",
  "rel.unreviewed":
    "release {taskKey}: branch {branch} contains commits above the " +
    "reviewed result {sha7}: {list}",
  "rel.unreviewedHint":
    "return the branch to result_sha or dispatch a review of the new result",
  "rel.mergeCommitMissing":
    "release {taskKey}: merge commit {sha7} ({key}) is missing in copy {repo}",
  "rel.mergeCommitMissingHint":
    "restore the merge commit or fix the merge record",
  "rel.foreignCommits":
    "release {taskKey}: commits without a merged delegation in the " +
    "{branch} range: {list}",
  "rel.foreignCommitsHint":
    "a review of the whole tip covers them: bb orchestrator delegate " +
    "{taskKey} --level <audit level> --from {tip}",
  "rel.noMergedReview":
    "release {taskKey}: no review of the merged result {label}",
  "rel.mergedReviewHint":
    "dispatch a review of the merged result: bb orchestrator delegate " +
    "{key} --level <audit level> --from {sha}",
  "rel.mergedReviewStatus":
    "release {taskKey}: review of {label} is in status {status}",
  "rel.mergedReviewVerdict":
    "release {taskKey}: review verdict of {label} {word}",
  "rel.verdictMissingWord": "not found",
  "rel.verdictNotOkWord": "not «OK»",
  "rel.prevPublishedMissing":
    "release {taskKey}: the previous published tip {sha8} is missing " +
    "in copy {repo}",
  "rel.prevPublishedMissingHint":
    "the new round continues from published_sha — retry from a copy " +
    "that has this commit",
  "rel.notFastForward":
    "the publication branch is not a fast-forward from {sha8} — the " +
    "new round must continue from published_sha",
  "rel.scanBlockers":
    "release {taskKey}: the machine scan found {n} blocking findings:\n{list}",
  "rel.auditInstr":
    "Release of task {taskKey}: release audit (pipeline step 5). " +
    "The audit input is file {packet} — read it in full. " +
    "Repository to check: {repo} (commit {sha} — check that one; the " +
    "copy's branch may differ after the release). " +
    "Result — ONE message of strict JSON " +
    '{\"verdict\":\"APPROVE\"|\"REJECT\",\"findings\":[…]} with no ' +
    "commentary; findings — with no secret values (mask them).",
  "rel.stoppedBeforeAudit": "the release stopped before the audit dispatch",
  "rel.stoppedBeforeAuditNotice":
    "release {taskKey} stopped before the audit dispatch — retry release",
  "rel.auditTimeout": "the audit did not finish within {min} min",
  "rel.auditTimeoutNotice":
    "release {taskKey} stopped: the audit did not finish within {min} " +
    "min — retry release",
  "rel.auditOutcome": "the audit finished with outcome {status}",
  "rel.auditOutcomeNotice":
    "release {taskKey} stopped: the reviewing agent finished with " +
    "outcome {status} — {why}",
  "rel.auditCancelled": "the audit was cancelled, no release",
  "rel.auditExhausted": "the {level} chain is exhausted, no release",
  "rel.rejectReasonUnparsable": "the auditor's reply does not parse",
  "rel.rejectUnparsableSuffix": " (unparsable reply)",
  "rel.rejectNotice": "release audit {taskKey}: REJECT{unp}\n{list}",
  "rel.noFindings": "- no findings in the reply",
  "rel.publishFailed": "release {taskKey} failed while publishing: {error}",
  "rel.selfReloadManual": "\nreload orchestrator manually: {error}",
  "rel.selfReloadUnconfirmed":
    "\nreload orchestrator manually: the automation is unconfirmed",
  "rel.prMerged": "PR merged {taskKey}: {url}{sha}",
  "rel.prMergedSha": " → {sha7}",
  "rel.prWatchImpossible": "cannot watch PR {taskKey}: {error}",
  "rel.prClosed": "PR closed unmerged {taskKey}: {url}",
  "rel.prStale": "PR pending {hours} h {taskKey}: {url}",
  "rel.viewNoCmd": "command.view is not set",
  "rel.viewExit": "command.view exited with code {code}: {tail}",
  "rel.viewNotJson": "command.view: reply is not JSON: {out}",
  "rel.viewBadState": "command.view: unexpected state: {state}",
  "rel.viewNone": "the provider changed to none — watching is impossible",
  "rel.ghViewNotJson": "gh pr view: reply is not JSON: {out}",
  "rel.ghViewBadState": "gh pr view: unexpected state: {state}",
  "rel.prUnavailable": "the PR provider is unavailable: {why}",
  "rel.ghNotAuth": "gh missing or not authenticated (code {code}): {tail}",
  "rel.cmdNotSet": "command.{kind} is not set",
  "rel.cmdNotFound": "command.{kind}: executable not found: {file}",
  "rel.prCredUrl": "PR not created: URL with credentials",
  "rel.foreignPr":
    "PR {url} of branch {branch} was not created by this release " +
    "(Источник: {src}) — release does not write to a foreign PR branch",
  "rel.noSrc": "none",
  "rel.findExit": "PR provider (find) exited with code {code}: {out}",
  "rel.viewErr": "PR provider (view): {error}",
  "rel.prCreateExit": "PR not created (code {code}): {out}",
  "rel.prNoOutput": "PR not created: {out}",
  "rel.prNoOutputWord": "no output",
  "rel.published": "released {taskKey}: {sha7} into {branch}; task done",
  "rel.branchPublished":
    "branch published {taskKey}: {branch}; open the PR manually",
  "rel.prCreated": "PR opened {taskKey}: —; watching until merged",
  "rel.prLine": "{word} {taskKey}: {url}; watching until merged",
  "rel.prUpdated": "PR updated",
  "rel.prOpened": "PR opened",
  "rel.kbNote": "KB note: {note}",
  "rel.kbNone": "KB not required: {reason}",
  "rel.postCheck": "post-check: {msg}",
  "rel.postCheckFail": "the post-check failed: {error}",
  "rel.selfReloadOk": "; reloaded: orchestrator",
  "rel.selfReloadFail":
    "; orchestrator did not come up after the reload / the copy is at " +
    "$last, expected $EXPECTED",
  "rel.fetchFailed": "fetch failed — {error}",
  "rel.landedOutside": "commits outside release landed on {branch}: {list}",
  "rel.notAncestor":
    "the published {sha8} is not an ancestor of {target} (remote head {head})",
  "rel.remoteMismatch":
    "remote branch {remote} points at {sha8}, we pushed {sha82}",
  "rel.prNotFound": "no PR found for branch {branch} → {target}",
  "rel.rescanNoBase":
    "scan skipped, no remote range base (first release onto a new branch)",
  "rel.rescanEmpty": "scan skipped, the remote range is empty",
  "rel.rescanFound":
    "the remote-range rescan found findings:\n{list}",
  "rel.rescanFailed": "the rescan failed: {error}",
  "packet.title": "# Release audit {taskKey}",
  "packet.task": "- Task: {taskKey} — {title}",
  "packet.repo": "- Repository (working copy with the task result): {repo}",
  "packet.branch": "- Branch: {branch} → {action} into {target}",
  "packet.range": "- Range: {base}..{head}",
  "packet.noDocs": "- --no-docs: {text}",
  "packet.kb": "- --kb: {text}",
  "packet.noKb": "- --no-kb: {text}",
  "packet.commits": "## Commits",
  "packet.docs": "## Related documents to check for staleness",
  "packet.noMap":
    "- no map: check all repository documents (docs/, README*, ADR)",
  "packet.noDocsTouched": "- no documents touched according to the map",
  "packet.findings": "## Machine scan findings (step 4)",
  "packet.none": "- none",
  "packet.diff": "## Release diff",
  "pp.cmdOk": "{name}: ok",
  "pp.cmdNoCheckout": "{name}: no checkout",
  "pp.cmdSkipped": "{name}: skipped — {tail}",
  "pp.cmdTimeout": "{name}: timeout",
  "pp.cmdInterrupted": "{name}: interrupted by a restart",
  "pp.cmdFailed": "{name}: failed (code {code}){tail}",
  "pp.noCheckout": "no checkout",
  "pp.copyUpdated": "copy updated",
  "pp.copyNotUpdated": "copy not updated",
  "pp.skipWhen": "no changes matching when",
  "pp.stoppedBy": "{name} did not pass",
  "pp.notWaited": "did not wait for {waiting}",
  "pp.waitLock": "the copy lock",
  "pp.waitQueue": "the command queue",
  "pp.waitFinish": "the steps to finish",
  "pp.noProject": "settings project not resolved",
  "pp.otherRepo": "a different repository — not updated",
  "pp.wrongBranch": "the copy is not on {branch} — not updated",
  "pp.fetchFailed": "fetch failed: {err}",
  "pp.ffFailed": "ff failed ({err})",
  "pp.reloadDisabled": "plugin reload is off",
  "pp.depsChanged":
    "{id}: dependencies changed — reinstall them and reload manually",
  "pp.registryUnread":
    "{id}: the provider registry could not be read — reload manually",
  "pp.turnsRunning": "{id}: turns in flight — reload later",
  "pp.cmdsRunning": "orchestrator: commands in flight — reload later",
  "pp.reloadFailed": "{id}: reload failed: {err}",
  "pp.reloaded": "reloaded: {list}",
  "pp.skipped": "skipped: {list}",
  "pp.selfReloading": "orchestrator is being reloaded by an automation",
  "pp.noChanges": "no plugins changed",
  "store.busyTarget":
    "a release to {target} is already running for {busyKey} — " +
    "one release per target",

  // ── server.ts / hooks ───────────────────────────────────────────────
  "hook.expired":
    "push refused: the release marker has expired — rerun " +
    "`bb orchestrator release`",
  "hook.wrongBranch":
    "push refused: the release marker was issued for another branch " +
    "({remote} ≠ the marker's branch)",
  "hook.wrongCommit":
    "push refused: the release marker was issued for another commit ({sha})",
  "hook.noToken":
    "push refused: publishing goes only through " +
    "`bb orchestrator release` (no one-time marker)",
  "status.moreErrs": " (+{n} more)",
  "status.fixSetting": "fix `{name}`",
  "status.reloadHint": " — then `bb plugin reload orchestrator`",
  "status.execChanged": "changed executable settings: {names}",
  "status.noIdentity":
    "warning: no commit author configured (release.commitIdentity) — " +
    "the scan does not block commit signatures",
  "status.noDelegations": "no delegations",
  "status.notifyMuted": " (notifications muted, pending auto restore)",
  "status.coordCancel": " (cancelled by the coordinator)",
  "cli.reminder":
    "The executor's report arrives as a message — end your turn.",
  "cli.noCodeDescribe":
    "Mark the delegation «no-code task» (§4.1 r28): the executor " +
    "must not commit, the watchdog does not expect commits",
  "cli.releaseUsage":
    "bb orchestrator release <KEY> [--no-docs <reason>] " +
    "[--kb <note>|--no-kb <reason>] [--json]",
  "cli.releaseUsageShort":
    "bb orchestrator release <KEY> [--no-docs <reason>] " +
    "[--kb <note>|--no-kb <reason>]",
  "cli.kbConflict": "--kb and --no-kb are mutually exclusive",
  "cli.releaseStarted":
    "release {taskKey}: audit dispatched (release #{id}, thread " +
    "{thread}; settings project {settings}, delegation project {delegation})",
  "cli.scanWarnings": "\nscan warnings:\n{list}",
  "cli.releaseReminder":
    "\nthe outcome arrives as an [orchestrator] message — end your turn.\n",
  "cli.delegated":
    "delegated {taskKey}: level={level} route={route} thread={thread} " +
    "(delegation #{id})",
  "cli.note": "note: {note}",
  "cli.setupErrors": "setup errors: {list}",
  "cli.cancelled": "cancelled delegation #{id}",
  "cli.noDelegation": "no delegation {ref}",
  "cli.noDelegationHint": "see `bb orchestrator status`",
  "cli.policyEmpty": "(policy is empty)",
  "cli.policyValid": "policy is valid",
  "cli.unknownPolicySub": 'unknown policy subcommand "{sub}" (show|validate)',
  "cli.cannotGenerate":
    "cannot generate the routing rule without a valid policy",
  "cli.cannotGenerateHint":
    "set it up via the `{skill}` skill (§2.1), then " +
    "`bb orchestrator policy validate`",
  "cli.noCallerThread":
    "release works only from a bb thread (BB_THREAD_ID is absent)",
  "cli.delegateUsage":
    "usage: bb orchestrator delegate <KEY> --level <level> " +
    "[--route <r>|--preset <p>] [--instructions <t>] " +
    "[--from <sha|branch>] [--fresh] [--no-code]",

  // ── policy.ts parse errors ──────────────────────────────────────────
  "pol.empty":
    "no routing policy — set it up via the `orchestrator-setup` skill",
  "pol.badJson": "invalid JSON: {error}",
  "pol.notObject": "policy must be a JSON object",
  "pol.version": "version must be 1",
  "pol.routesReq": "required object of route definitions",
  "pol.routeObject": "route must be an object",
  "pol.presetReq": "required non-empty preset name",
  "pol.providerReq": "required non-empty provider id",
  "pol.nonEmptyString": "must be a non-empty string",
  "pol.stringArray": "must be an array of non-empty strings",
  "pol.maxPatterns": "at most 20 patterns",
  "pol.seconds30600": "must be a number in 30–600",
  "pol.numGe30": "must be a number ≥ 30",
  "pol.numGe60": "must be a number ≥ 60",
  "pol.levelsReq": "required object of level definitions",
  "pol.levelObject": "level must be an object",
  "pol.isString": "must be a string",
  "pol.isBool": "must be a boolean",
  "pol.roleEnum": 'must be "auditor" or "executor"',
  "pol.chainReq": "required non-empty array of route names",
  "pol.routeNameStr": "route name must be a non-empty string",
  "pol.routeUndeclared": 'route "{route}" is not declared in routes',
  "pol.reviewByLevelObject":
    "must be an object of level → review level",
  "pol.levelUndeclared": 'level "{level}" is not declared in levels',
  "pol.levelNotExecutor": 'level "{level}" does not have role "executor"',
  "pol.levelName": "must be a level name",
  "pol.levelNotAuditor": 'level "{level}" does not have role "auditor"',
  "pol.isObject": "must be an object",
  "pol.intGe1": "must be an integer ≥ 1",
  "pol.perLevelObject": "must be an object of level → cap",
  "pol.capOverMax": "must be ≤ limits.maxActive ({max})",
  "pol.byProviderObject":
    "must be an object of provider id → seconds",
  "pol.timingObjectIgnored":
    "must be an object of timeout values — ignored",
  "pol.outOfBoundsDefault":
    "out of bounds {min}..{max} — using default",
  "pol.numGe300": "must be a number ≥ 300",
  "pol.presetNotFound":
    'preset "{preset}" not found in bb tasks preset list',
  "pol.presetNoWorktree":
    'preset "{preset}" does not create a worktree ' +
    "(environmentKind={kind}); level \"{level}\" needs its own " +
    "executor copy",

  // ── release-config.ts parse errors ──────────────────────────────────
  "rc.targetObject": "must be an object {action, branch}",
  "rc.actionEnum": 'must be "push" or "pr"',
  "rc.branchReq": "required non-empty branch name",
  "rc.isObject": "must be an object",
  "rc.syncEnum": 'must be "merge" or "rebase"',
  "rc.checksArray": "must be an array of non-empty commands",
  "rc.commandNonEmpty": "must be a non-empty command",
  "rc.isBool": "must be a boolean",
  "rc.docsMapObject": "must be an object path-prefix → doc paths",
  "rc.docsMapPrefixes": "path prefixes must be non-empty strings",
  "rc.docsArray": "must be an array of non-empty doc paths",
  "rc.leaksObject":
    "must be an object {machine, bbIds, trailers, allow}",
  "rc.leaksEnum": 'must be "block" or "warn"',
  "rc.pathsArray": "must be an array of non-empty paths",
  "rc.commitIdentity": 'must be "repo" or a "Name <email>" signature',
  "rc.stringArray": "must be an array of non-empty strings",
  "rc.trailerName":
    'must be a known trailer name ("Co-Authored-By", ' +
    '"Signed-off-by", "Generated with", "Generated-by"), ' +
    'optionally ": <value prefix>"',
  "rc.providerType": 'type must be "github", "command" or "none"',
  "rc.argvArray": "must be a non-empty argv array of strings",
  "rc.requiredForCommand": 'required for type "command"',
  "rc.ignoredForType": 'ignored — type is "{type}"',
  "rc.templateString": "must be a string template",
  "rc.timingObject": "must be an object of timeout values",
  "rc.outOfBoundsDefault":
    "out of bounds {min}..{max} — using default",
  "rc.ppObject":
    "must be an object {checkout?, branch?, reloadPlugins?, " +
    "on?, commands?}",
  "rc.checkoutPath": "must be a non-empty checkout path",
  "rc.branchNonEmpty": "must be a non-empty branch name",
  "rc.onEnum": 'must be "published" or "merged"',
  "rc.commandsArray": "must be an array of command objects",
  "rc.commandObject": "must be an object {name, run|command, …}",
  "rc.commandNameReq": "required non-empty command name",
  "rc.dupCommand": 'duplicate command name "{name}" — skipped',
  "rc.runReq": "required `run` argv array (or a `command` string)",
  "rc.cwdPath": "must be a non-empty path or `checkout`",
  "rc.timeoutBounds": "out of bounds 5..3600 — ignored",
  "rc.whenArray": "must be an array of non-empty glob patterns",
  "rc.ppNeedsSomething": "needs at least a checkout or one command",
  "rc.badJson": "invalid JSON: {error}",
  "rc.notObject": "release config must be a JSON object",
  "rc.projectsObject": "must be an object of bb-project overrides",
  "rc.projectIds": "project ids must be non-empty strings",
  "rc.mergedOnPush": '"merged" at a push target reads as "published"',
  "rc.mergedNever": '"merged" never fires — prProvider is "none"',
  "rc.missingCheckout":
    '"{name}" needs the missing checkout — it reports "no checkout"',

  // ── tool descriptions / CLI help ────────────────────────────────────
  "tool.delegate":
    "Dispatch a bb task to an executor thread under the routing " +
    "policy (spec: docs/specs/orchestrator.md)",
  "tool.delTaskKey": "Task key, e.g. PLUG-129",
  "tool.delLevel": "Level name from the routing policy",
  "tool.delRoute":
    "Any route name declared in the policy (not only the level's " +
    "chain); defaults to the first available",
  "tool.delPreset":
    "One-off: an existing `bb tasks` preset name, dispatched outside " +
    "the policy. Mutually exclusive with `route`",
  "tool.delInstructions":
    "Extra instructions for this dispatch only",
  "tool.delFrom":
    "Continue this round from an explicit sha or branch (§6 --from)",
  "tool.delFresh":
    "Start the round without continuing the previous result " +
    "(§6 --fresh)",
  "tool.status":
    "List this coordinator's delegations and counters (active vs " +
    "policy limits).",
  "tool.statusAll": "Include delegations of all coordinators",
  "tool.cancel":
    "Cancel a delegation: stop the executor thread and mark the " +
    "record cancelled. Accepts a delegation id or thread id.",
  "tool.cancelTarget":
    "Delegation id (number) or executor thread id (thr_…)",
  "cli.helpSummary":
    "Delegate bb tasks to executor threads under the routing " +
    "policy (spec: docs/specs/orchestrator.md)",
  "cli.helpDelegateS": "Dispatch a task to an executor under the policy",
  "cli.helpStatusS": "Delegations and counters",
  "cli.helpShowS": "One delegation by id or thread id",
  "cli.helpCancelS":
    "Stop the executor and mark the delegation cancelled",
  "cli.helpMergeS":
    "Merge a finished round's result into the coordinator's " +
    "worktree (§14)",
  "cli.helpPolicyS": "Show or validate the configured policy",
  "cli.helpInstructionsS": "Print the generated routing rule (§3)",
  "cli.helpReconcileS":
    "Force a reconciliation pass (watchdog stage)",
  "cli.helpReleaseS":
    "Deterministic publish pipeline (spec orchestrator-release §2)",
  "cli.helpHooksDirS":
    "Directory of the shared pre-push hook + push token",
  "cli.helpJanitorS":
    "Janitor: merged copy/branch/thread cleanup (§15)",

  "tool.delegateInstr":
    "Use orchestrator_delegate instead of running `bb tasks dispatch` " +
    "+ `bb thread update` by hand. The executor's report arrives as a " +
    "message — finish your turn after delegating.",
};
