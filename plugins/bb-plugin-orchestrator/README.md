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
  comments "Delegated" on the task. `--no-code` (tool `noCode`) marks a
  delegation that expects no commits (§4.1 r28): the executor is told to
  report only — the §2.2 git memo's commit/branch/SHA requirements are
  left out (r28.1); the watchdog drops "no commits" and flags commits
  that appear anyway; the mark rides watchdog reissues only (a new
  `delegate` without the flag is an ordinary dispatch), shows as
  `no-code` in `status`/`show`, and makes `merge`/`release` refuse
  "a no-code task: nothing to merge" when the last round produced no
  commits (r28.1).
  **Delegation base (§22.2):** a managed-worktree dispatch runs
  `git fetch` on the target repo and bases the executor copy on
  `origin/<baseBranch>` (the remote's default branch when the preset
  names none) — never on the project copy's local branch, which may
  carry unpushed commits. A new round of the same task without
  `--from` still continues the work from the previous round's tip
  (§4.1) — the executor merges it onto the fresh base. `--from <ref>`
  is checked as `origin/<target>..<ref>` and refuses only when
  `<ref>` is the copy's local target branch (`main`/`master`/`dev`)
  carrying commits that are neither in `origin/<base>` nor from this
  task (its own rounds, results merged by `bb orchestrator merge`,
  release-pipeline shas): `from-unpublished: <n> коммитов не в
  origin/<цель> и не из этой задачи`. `HEAD` resolves to the copy's
  current branch first, so `--from HEAD` on a local target branch
  with unpublished commits refuses just like `--from main` — only a
  coordinator's spec branch and a bare sha always pass. A failed
  `git fetch` or a missing `origin/<baseBranch>` refuses
  `base-unavailable: <error>`; where git is unreachable (a foreign
  target host, no `local_path` source on it, an unreadable
  `bb project list`, no cmd runner) the check skips, the spawn keeps
  the preset's base, and the delegate response names the reason:
  "base not checked: <reason>". `--attach <path>` (repeatable, §20.1 п.4) hands the
  dispatch extra files as a path list in the seed prompt and task
  instructions — the agent opens them in its own working copy.
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
  §25.6: a delegation the coordinator cancelled itself (`bb orchestrator
  cancel`) produces NO result delivery at all — no `[orchestrator]`
  line, no output tail, no journal check; the row is recorded
  `result_notice = 'self-cancel'` (a cancel NOT by the coordinator —
  UI, cascade, archive — still gets its one line).
- **Coordinator watchdog** (§5.6): supervises idle coordinator threads
  when work is pending (backlog below `maxActive`, done unmerged
  without an active release (settled no-code rounds and dropped staged
  features excepted), failed, or stalled/quota delegations). Sends
  reminders at cumulative $N$, $3N$, $7N$ of silent idle; after
  `coordinatorMaxNudges` reminders (+4N) escalates to the parent
  thread or sends a push notification to the owner for root coordinators.
  Active executors pause the timer. The schedule resets on productive
  plugin actions (tools, CLI delegate|cancel|merge|release|helper|kb),
  user messages (excluding system notices and `bb thread tell` messages),
  or when all pending work is cleared.
- **`merge`** (agent tool `orchestrator_merge` + CLI, §14): merges a
  finished round's `result_sha` into the coordinator's worktree after the
  §14 checks (clean result, clean coordinator copy, non-protected target,
  fresh executor HEAD per §16.2, one merge per copy). A conflict aborts
  back to a clean copy; with the `mergeAutofix` setting on, a fix round is
  delegated to the same task and level. Protected branches refuse —
  `release` owns them.
- **`release`** (CLI `bb orchestrator release <KEY>`, spec
  orchestrator-release §17.3): the only path code takes to a remote —
  acceptance (including the per-published-SHA review gate) → branch sync →
  project checks → machine leak scan (every commit's patch, §16.6) →
  audit agent → publish (`push` or `pr`) → post-check.
  A merged round publishes its `merged_into` branch from the
  coordinator's copy; anything else the executor's branch.
  **Review gate (§17.3 B4):** the branch being published must be
  reviewed — an executor branch's tip must equal the reviewed
  `result_sha`; commits above it refuse with `unreviewed-commits`
  (the pipeline's own sync-merge/docs-trailer commits, recorded in the
  release row, do not count). On a `merged_into` branch an OK review
  bound to the branch TIP covers everything below (coordinator docs
  included); without one, every merged delegation whose `merged_sha`
  is on the tip but not yet published needs its own OK review, and no
  commit may remain unexplained. Re-review a new tip with
  `bb orchestrator delegate <KEY> --level <audit> --from <sha>` —
  `--from <merged_sha>` binds the review to a merged result.
  **Shared hooks (§17.3 B2):** `hooks/install.mjs` sets a global
  `core.hooksPath` and installs a wrapper under every `githooks(5)`
  name EXCEPT `push-to-checkout` — its mere presence disables git's
  built-in worktree update on `receive.denyCurrentBranch=updateInstead`;
  the installer removes a wrapper an older install left under that
  name. The same shadowing works the other way too: while a global
  `core.hooksPath` is set git reads hooks ONLY from it, so a
  repository's own `.git/hooks/push-to-checkout` never fires anyway —
  keeping the name in the wrapper set would buy nothing. `pre-push` is
  the orchestrator push gate and `pre-commit` (§22.1) the staged-diff
  leak gate — both chain to the local hook afterwards; the rest are
  copies of `chain`, which execs the repo's own `.git/hooks/<name>` —
  only when it is executable, like git itself. The shared `pre-push` is a
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
  **Shared `pre-commit` (§22.1):** scans the staged diff's added lines
  with the same leak rules the release machine scan uses — the shared
  core lives in `hooks/leak-scan.ts` and ships next to the wrappers.
  Severity `block` refuses the commit, `warn` prints a warning and
  lets it through. The hook reads the resolved leak settings from
  `<git-common-dir>/orchestrator-leaks.json`, which the plugin refreshes
  on settings load, on every settings save, on each delegation and
  whenever it resolves the repo's release project; written from a
  worktree the snapshot lands in the shared git dir, so every linked
  worktree is covered. With no snapshot the embedded defaults apply —
  including `os.hostname()` and the built-in `leaks.allow` exceptions
  (`tests/fixtures/leak-samples.ts`). `threadIds` (default on) allows
  the thread-id marker in the PR body from the `prBody` template
  (default `BB-Thread: {thread}` / `BB-Task: {task}`) and exempts
  `thr_…` in COMMIT MESSAGES from the bb-ids leak rule — the
  `BB-Thread:` trailer and the message text (§22.5), only in the
  release machine scan's commit scan (§16.6): `pre-commit` never
  reads the commit message. In file CONTENT `thr_…` is a
  finding everywhere (§22.5): the release scan flags it in the
  release diff and every commit's patch, `pre-commit` in the staged
  lines — `leaks.allow` places aside in both. Off — `prBody` is not
  applied, the body is empty, and every `thr_…` is a `leaks.bbIds`
  finding, the commit-message trailer included (see "PR body").
  `allowedTrailers` / `allowedEmails` (§17.3 C6) exempt matching
  commit trailers (e.g. `Co-Authored-By`) and e-mail addresses/domains
  from the machine scan's `foreign-bot-trailer` / `personal-email`
  rules. Non-exempt foreign-bot trailers follow `leaks.trailers`
  (§18.6): `block` | `warn`, default `warn` — the author's install
  pins `"block"` explicitly. The `commitIdentity` signature check
  (§18.6) has four outcomes: no key at all → the signature finding
  only warns and `bb orchestrator status` reports "commit author not configured"; a resolved identity (a literal `Name <email>` or `"repo"`
  answered by the repo config) blocks every commit whose signature
  differs; `"repo"` with no `user.name`/`user.email` in the repo
  config refuses "user.name/user.email not set in the repo config", and a literal that does not parse refuses
  "could not parse commitIdentity". The post-check (§2 step 7)
  without a release config keeps the pre-§18.6 strict defaults — the
  signature finding blocks there too. Secrets (category 1) always
  block. `leaks` of a project merges with `defaults.leaks` key by key
  (like `timing`), never replaces it whole.
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
  "audit without a verdict"). For `pr` targets the pump checks the PR through `prProvider`
  (`gh pr view` for `github`, `view` for `command`; `none` — no
  tracking) every `timing.prPollMinutes` (5): merged → "PR merged" +
  task done, closed → one line + `timing.prReopenWatchHours` (72 h)
  for a reopen-merge, open `timing.prStaleHours` (72 h) → one
  "PR open for 72 h" line, `timing.prErrorLimit` (3) provider failures
  in a row → one "tracking impossible" line.
  `postPublish` (`{checkout, branch?, reloadPlugins}`) fast-forwards a
  configured checkout after push and reloads the changed plugins —
  dirs with a changed manifest need `npm ci`, providers with running
  turns are postponed, and the orchestrator plugin reloads itself via
  a one-shot script automation (it cannot reload itself). Before the
  fast-forward the copy is checked in order (§22.3), each failure
  with its own line: "the copy is on <branch|a detached commit> —
  the new version is not loaded; switch the copy to <target>" (not on
  the target branch or detached), "the copy has <n> local commits not
  in <target> — the new version is not loaded" (diverged from
  origin), "the copy has uncommitted changes (<n> files) — the new
  version is not loaded" (dirty per `git status --porcelain -uno`, or
  untracked files colliding with `git diff --name-only
  HEAD..origin/<target>` — other untracked files do not block); when
  the checks pass but the fast-forward itself fails — "could not
  update the copy — the new version is not loaded; details in the
  plugin log". Raw git output goes only to the plugin log, and no
  reloads run in these cases. When at least one reloaded plugin has
  an `app` field in its `plugin.json` (or the file it points at
  exists), the outcome line ends with "reload the BB page to see the
  new version: <id>, <id>" (§22.4).
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
  `instructions`, `reconcile`, `release`, `janitor`, `hooks-dir`, `helper`,
  `role set`, `kb`.

## Roles

Built-in roles (§13.1, r33 §19/§21): `orchestrator` (the only one with
`delegates: true`), `executor`, `auditor`, `release-auditor`,
`researcher` (internet research without project files — §21), `helper`
(the worker a plugin launch creates — never pickable), and `none` — an
explicit "no plugin" verdict: no tools, no skills, no instructions, no
coordinator fallback. A role is its instruction text plus the plugin
tools and skills the thread may use.

- **Picker**: the "Role" dropdown (`composer.customize`) sits in the
  composer of BOTH the new-chat window and any thread window (§25) with
  `none` ("No plugin") first. In the new-chat window it only READS the
  stored pick — it writes nothing on open, so an explicit selection is
  distinguishable; the pick is stored per project in `pending_roles`.
  In a thread window it shows the thread's decided role from
  `thread_roles` (no row → "No plugin"; a helper thread's list is
  disabled showing "Helper") and the owner's change writes the row
  with `source = "owner"`, refreshes the `pluginMetadata.role` badge,
  and journals `role.manual` — it takes effect on the thread's NEXT
  turn (`configure` re-reads the role every turn); the running turn is
  not interrupted. There are no participation restrictions: the owner
  may re-role a thread that runs delegations or helpers — a thread
  that became `orchestrator` may `delegate`/`merge`/`release`, even
  delegations another coordinator authored (merge/release check the
  caller's role, not `coordinator_thread_id`).
- **Decision**: the `message.dispatch` hook decides the role once, on the
  thread's first message, and writes it to `thread_roles` — the source of
  truth (`pluginMetadata.role` is display-only). A CLI thread without a
  parent gets `none`; children and forks of a `none` thread inherit it.
  Threads older than the r33 migration fall back to the §3 criterion:
  no parent and no executor markers → coordinator; newer threads without
  a recorded role are `none` (a journal warning names the hole).
- **Manual role**: the owner changes the role in the thread window
  (§25 — see Picker). From the CLI, `bb orchestrator role set <thread>
  none` is the ONLY manual change (§19.4) — every other target refuses
  `role-not-allowed`; an agent never promotes a role (the `setThreadRole`
  RPC is technically reachable, so every change lands in `role.manual`
  with its actor and the role texts forbid calling it). A helper
  thread's role cannot be touched, active work refuses `role-active`,
  and the demotion clears the `pluginMetadata.role` badge.
- **Limitations** (§13.2 item 5, §13.3): the plugin grants and withholds only
  its own tools — provider built-ins (file edits, shell) stay governed by
  the preset's permission mode. The role's instruction reaches the agent
  only if the provider delivers BB instructions; on a provider that does
  not, the role carries no text (agy on the ACP bridge delivers it; `acp-devin`
  restores instructions after compaction via `provider-devin`).

## Coordinator worktrees

Managed coordinator worktrees are governed by `coordinatorWorktrees: "off" | "on"` (default: `"off"`) in `bb.settings.define` under §23 protection. Until this mode is enabled by the owner, BB removes a thread's worktree 5 minutes after the last thread using it is archived, and unpushed local changes are lost. When working in a shared project before the mode is enabled, keep coordinator threads unarchived, save local work, and commit changes before archiving.

When enabled (`coordinatorWorktrees: "on"`), each coordinator thread runs in a separate BB Worktree environment with its own branch based on the current remote target. Fetch the target and integrate it in that worktree before publishing. Releases to the same repository and target branch use a single publication lock.

Keep the coordinator thread unarchived while its worktree is needed. Before archiving, save local work and check that the branch's changes are on the target. The [planned lifecycle](../../docs/specs/orchestrator.md#169-жизненный-цикл-рабочей-копии-координатора) requires BB retention before managed coordinator worktrees are enabled. A promotion from executor to coordinator unbinds the promoted thread from its parent (`bb thread update <id> --clear-parent-thread`), retains the existing environment under `coordinator-live` protection, and requires a separate integration worktree before merge or release operations. Branches registered in `coordinator_worktrees` are protected from post-release cleanup.

## Helpers (§19)

`orchestrator_helper` (agent tool) and `bb orchestrator helper` create a
plugin-owned worker thread for the calling orchestrator or executor:
a hidden child linked to the caller with `parentNotifications: auto`,
running inside the caller's own environment (`{type: "reuse"}`), titled
`helper#<id> · <title>`. Helpers get the `helper` role — no plugin tools
or skills; the result reaches the caller through BB's own parent
notification, the plugin sends only the launch notice and outcome lines.

- `bb orchestrator helper --prompt <text>|--prompt-file <path>
  [--title <t>] [--level <l>|--preset <id>]` — a level goes through the
  policy chain (`helpers.defaultLevel` when omitted); a preset names one
  policy route directly (`preset-not-allowed` for foreign presets).
- `bb orchestrator helper cancel <id>` — idempotent cancellation; the
  caller or its delegation's coordinator may cancel. `orchestrator_cancel`
  accepts `helperId` too.
- **Supervision**: the watchdog records outcomes (`done`, `failed`,
  `quota`, `stalled`, `cancelled`), issues at most one continuation on an
  interrupted turn, sends exactly one caller line per terminal outcome
  (`notified_at` survives restarts), relinks dispatch rows by
  `pluginMetadata.helperId`, and cascades — an archived/deleted caller or
  a finished delegation cancels its helpers; a helper thread removed by
  hand is `cancelled` + one «removed manually» line.
- **Limits**: `helpers.maxActive` is the PER-CALLER cap (default 3;
  `maxPerCaller` is accepted as a legacy alias), and helpers also count
  inside the policy's shared `limits.maxActive` together with
  delegations — both are checked atomically with the row insert inside
  the dispatch queue.
- **Delegation interplay**: active helpers keep their delegation
  `running` (`helpers-pending` mark — the timer re-evaluates after they
  finish), and `merge` refuses with `helpers-active` until they end.
- **Foreign children**: a manual `bb thread spawn`/`bb tasks dispatch`
  child of a role thread is rejected on its first message — children of
  role threads are plugin-created only. `allowForeignChildren` is an
  `originPluginId` allowlist (empty — refuse all).

## Knowledge Base (§26)

`orchestrator_kb` (agent tool) and `bb orchestrator kb` provide safe knowledge base
operations (`list`, `search`, `read`, `write`, `append`, `sync`, `status`) inside
`<kb.path>` (`~/kb` or `~/.bb/kb`):
- Path boundary containment (no `..`, `.git/`, null bytes or symlink escapes).
- Secret leak scanning on content before write and commit.
- Exclusive file lock (`orchestrator-kb.lock`) with stale PID cleanup.
- RBAC: full access for `orchestrator` and `executor`; other roles are not granted the tool; if explicitly attached, their access is restricted to read-only (`list`, `search`, `read`, `status`), and mutating operations are rejected with `permission-denied`.
- Release integration: Step 1 verifies a clean repository (`requireCleanOnRelease`); Step 7 auto-records UTC release notes into `<kb.path>/releases/<YYYY-MM-DD>-<KEY>.md` with idempotency.

## Uniform tools contract: busy-route queue, policy aliases and the researcher (§20–§21)

r34.4 removed the `tools: false` route kind and the auditor packet
module: every route dispatches an ordinary agent with tools — task,
working copy, base and head links — and how a provider without native
tools receives material is that provider plugin's own concern. A
policy that still carries `tools`, `maxPromptBytes` or `splitPackets`
loads with a deprecation warning, never an error (§20.2).

- **`--attach`** (§20.1 п.4): repeatable; on every route the paths go
  into the seed prompt and task instructions as a list — the agent
  opens them in its own working copy; the orchestrator never inlines
  file bytes into the first prompt.
- **Busy route** (§20.1 п.5): any route with `maxActive` (counted over
  its `quotaGroup`) parks the row `dispatching` under `queued_at`
  instead of falling to the next chain route at once; the watchdog
  retries in `queued_at` order (FIFO) and after `routeBusyWaitSeconds`
  (default 1200) the dispatch advances to the next chain route, or
  fails `route-busy-timeout` when no alternative remains. The queue
  counts inside `limits.maxActive`.
- **Policy aliases** (§20.3): `routeAliases`, `presetAliases` and
  `quotaGroupAliases` translate route, preset and quota-group names —
  no provider names are hardcoded. A direct config match wins over an
  alias lookup, chains resolve to the terminal name, a cycle is a
  blocking `alias-cycle` error.
- **Researcher** (§21): the `research` level role and a window pick —
  internet research that spends no coordinator tokens: cite sources
  for material claims, separate facts from conclusions, say what was
  not found; no code edits, no subagents, no plugin tools, no handoff.
  `delegate --level research` and `helper --level research` dispatch
  researchers like any route; `reviewByLevel` does not apply; `role
  set` cannot name `researcher`.

## Setup

No bundled model sets — setup is a walkthrough the agent runs with the
user via the `orchestrator-setup` skill (§2.1): inventory the providers,
map presets onto levels and fallback chains, write the policy, validate.

- `language` (`en` | `ru`, default `en`, §18.1) — the language of every
  human/agent-facing text the plugin produces: coordinator messages, CLI
  and tool output, executor instructions (the no-code line, «Round N»),
  the routing rule, the default git memo, and the `pre-push` hook's
  refusal messages. Strings live in `src/i18n/<lang>.ts` catalogs; a key
  missing in the selected language falls back to English with a log
  warning. Machine contracts are never translated: the verdict JSON,
  error codes, setting and field names, `prBody` markers, and journal
  labels. A `gitInstructions` value equal to the built-in text of either
  language counts as the default and is emitted in the current language;
  a custom value goes out verbatim, empty disables the section. The
  plugin declares the current language's skill set
  (`orchestrator-coordinator`/`orchestrator-setup` or their `-ru` twins)
  and rewrites an installed `pre-push` hook on a language change — its
  texts are versioned with the language. Tool descriptions and CLI help
  are registered at plugin load — after a `language` change they refresh
  on `bb plugin reload`.
- `policy` (multiline JSON, §2) — levels, route chains, limits, quota
  groups. Empty or invalid → `needs-configuration`, `delegate` refuses.
- `gitInstructions` (§2.2, ≤ 1500 chars) — the «Working with git» section
  prepended to every dispatch's instructions (the spawn prompt's
  «Additional instructions»); empty disables it.
- `injectInstructions` (default on) — off silences every plugin-generated
  text; tools and `orchestrator-setup` stay.
- `roleTexts` (multiline JSON, §18.6) — `{orchestrator|executor|auditor:
  "…"}`: text APPENDED to the built-in role instruction (not a
  replacement). The plugin always adds the mandatory parts itself — the
  `sudo`/package-install/host-change ban on `orchestrator`/`executor`
  and the strict JSON verdict line on `auditor` — so a `roleTexts`
  value cannot remove them; `release-auditor` is not customizable. The
  composed text must stay within 2500 characters per role, checked on
  the real substitutions (`handoffPath`, the policy's review level
  name); an invalid document or an over-limit result is reported as
  needs-configuration and ignored whole. If later substitutions (a
  policy or `handoffPath` change) push the composed text over the
  limit at use time, the addition is dropped for that render — the
  mandatory tail is never cut.
- `handoffPath` (§18.6, default `$BB_THREAD_STORAGE/HANDOFF.md`) — the
  handoff file path substituted into the role texts' handoff rule and
  the §16.5 compaction reminder; one line, at most 256 characters — a
  multi-line or over-limit value is refused at write time, and a
  stored invalid one is ignored (the default applies) with a
  needs-configuration line. The `~/.cache/bb-handoff/<thread>.md`
  fallback for providers without `$BB_THREAD_STORAGE` stays built-in.
- `userThreadPlugins` (§17.1, comma/space-separated) — plugin ids whose
  threads continue a human chat (session handoff, chat compaction):
  their threads inherit the source thread's role (`none` included);
  a root thread without a source gets `defaultRole` (`executor` by
  default). Default EMPTY — a plugin-born thread gets the `none` role
  unless its id is listed here. Only an explicitly SAVED value is kept
  on upgrade — set it before updating (e.g. `bb plugin config
  orchestrator set userThreadPlugins "handoff external-compact"`), not
  rely on the previous schema default.
- `release` (multiline JSON, orchestrator-release §6) — the release
  pipeline config: `commitIdentity`, `defaults` and per-project
  overrides (`target`, `sync`, `checks`, `public`, `docsMap`, `leaks`,
  `excluded`, `threadIds`). Empty — `release` refuses (the pipeline is
  disabled).
- `mergeAutofix` (default off, §14/§16.6) — on a merge conflict,
  delegate a fix round to the same task and level; off — only report
  the conflict to the coordinator.
- `defaultRole` (§19.3, default `executor`) — the role an undecided
  human/app thread gets: `orchestrator`, `executor`, `auditor`,
  `researcher` or `none`.
- `helpers` (§19.1, JSON) — `{maxActive?, maxPerCaller?, defaultLevel?}`;
  `maxActive` is the per-caller cap (default 3, `maxPerCaller` a legacy
  alias), helpers also count inside the policy's `limits.maxActive`.
- `allowForeignChildren` (§19.5, comma-separated) — an `originPluginId`
  allowlist whose threads may run as children of role threads (`*`
  allows all; a legacy boolean `true` reads as allow-all). Empty — such
  a child's first message is rejected and the thread archived.
- `maxConcurrentCommands` (§18.2, default 4) — cap on simultaneously
  running journaled commands (postPublish and event hooks).
- `retentionDays` (§18.2, default 30) — `command_runs` and `events`
  entries older than this are pruned.
- `eventHooks` (multiline JSON, §18.5) — event hooks
  `[{name, on, run, projects?, timeoutSec?, notifyOnFail?}]`; see
  "Event hooks (`eventHooks`)" below. Empty — no hooks.
- `janitor` (multiline JSON, §15–16, default `{"enabled": false}`) —
  the janitor config: `enabled`, `mode apply|report`, `afterMerge`,
  `abandonedAfter`, `intervalMinutes`, `excludeProjects`,
  `protectedBranches`, `deleteBranches`, `scope workers|all`. An
  invalid document warns in the journal and keeps the janitor off.
- `kb` (multiline JSON, §26) — knowledge base settings: `enabled` (default
  `true`), `path` (default `~/kb` or `~/.bb/kb`), `autoSync` (default `true`),
  `requireCleanOnRelease` (default `true`). Empty or unset uses defaults.
- `needs-configuration` clears only on plugin reload (SDK V1): after
  fixing a setting run `bb plugin reload orchestrator`.

## Migrating from manual dispatch

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

## Janitor: recovery

Before every removal the janitor records the removed object's SHA in the
database (`janitor_items.tip_sha`) and a plugin journal line
(`removed branch|copy <repo>:<branch> at <sha>`; for a copy — also its
HEAD); `bb orchestrator janitor run`/`report --json` print them. To
bring back a removed branch:

```
git -C <repo> branch <branch> <sha>
```

Recovery works until `git gc` drops the objects — roughly two weeks
(the default `gc.pruneExpire`). After that neither the branch nor the
copy can be restored.

Uncommitted work in an executor's dirty copy is rescued with a snapshot
(`refs/orchestrator/rescue/<thread>[-<N>]`) on both thread archival and
deletion — inside the ~5 minute window before BB cleans the environment
up; every attempt is written to the rescue ledger and shows in
`bb orchestrator janitor report` (including when the coordinator line
never arrived). For the round result (§4.1 `result_dirty`) an untracked
`node_modules` — a directory or a symlink, at any depth — is
reproducible dependency state and does not make a copy dirty; every
other status line does.

Two report-only flags mark abandoned copies that look already
published — neither ever leads to removal; both land in
`janitor report` and the daily coordinator notice, tagged ` (squash?)`
or ` (content?)` there. `squash-suspect` ("looks squash-merged; check
and remove manually") fires when the copy's tree matches the target
under `merge-tree` while its commits failed the ancestry/`patch-id`
check; `content-on-target` ("content matches the target; check and
remove manually") is checked first and fires when `git cherry <target>
<tip>` prints no `+` line, or every file the tip changed against the
merge-base equals its version on the target (`--no-renames`,
`--literal-pathspecs`).

## Fitting your process

After a publish, `release` can run `postPublish` steps: update a
configured checkout, run commands through the shared runner (the
`command_runs` ledger), reload plugins. The full schema is
`docs/specs/orchestrator-release.md` §6 and `docs/specs/orchestrator.md`
§18; frequent examples follow.

> Every command in this section is **executed by the plugin itself with
> BB's rights**. Each run is journaled (argv, cwd, up to 300 chars of
> output with secrets masked) and goes as an argv list without a shell —
> `sh -c` is used only when you write the command that way yourself.
> Masking is a safety net against typical leaks (tokens, passwords in
> URLs), not a guarantee: a secret in a non-standard shape stays in the
> journal — do not print them. Changing executable fields (`eventHooks`,
> `postPublish.commands`, `checks`, a `command`-type `prProvider`) is
> captured by the trust snapshot and reported to coordinators with
> unfinished work — do not enable hooks and postPublish for settings you
> do not trust. Hooks and commands run as the BB user: an agent with
> shell access (and the `bb` CLI) can change these settings — giving
> agents a shell means trusting them with it.

### Plugin at the repository root

`checkout` is any directory, not necessarily `…/plugins/<id>`: the
plugins reloaded are those whose `rootDir` in the registry lies inside
the checkout and whose files changed. `checkout` may be omitted — then
only the commands run.

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

### A custom action after publish

`commands` is a list of `{name, run | command, cwd, timeoutSec, when,
stopOnFail, installsDeps}`: `run` — an argv array without a shell
(schema §18.2), `command` — an `sh -c` string when a shell is really
needed. `cwd: "checkout"` — the checkout directory, otherwise a path
(relative — from the repository directory); the default is `checkout`
when configured, else the repository's main directory. The env carries
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

`when` — globs (`*`, `?`, `**`), at least one must match a path the
publish changed; `stopOnFail` — a failed required command skips all
later ones; `installsDeps` — a successful command clears the plugins'
"dependencies changed — reinstall manually" skip.

### GitLab and other PR providers

`prProvider` is set in the `defaults`/`projects` layers; a project's
object replaces the `defaults` object whole, with no per-key merge —
unlike `timing` and `leaks`. It picks what opens and tracks the PR
(§18.3):

- `{ "type": "github" }` — the default; works through `gh`. `gh auth
  status` is checked at release step 1, before the audit.
- `{ "type": "command", "create": [...], "view": [...], "find": [...]? }` —
  your own executables (argv, no shell). `create` and `view` are required
  and checked at step 1: a missing or non-executable file refuses the
  release before the audit. `find` is optional.
- `{ "type": "none" }` — the branch is published, no PR is opened or
  tracked: the "branch published …; open the PR manually" line, task
  `in_review`. `postPublish.on: "merged"` never fires with `none` — the
  setting warns about it when read.

The `command` contract (working directory — the repository's main
directory, timeout `timing.prCommandTimeoutSec`): provider commands go
through the same runner as `postPublish.commands` — each in its own
process group, on timeout the group gets SIGTERM then SIGKILL, so a
stuck wrapper cannot wedge the release or the tracking. `create` gets
`ORCH_BRANCH`, `ORCH_TARGET`, `ORCH_TITLE` and the PR body on stdin and
prints the URL (`https?://…` — the first such line); a non-zero exit is
a refusal even when a URL was printed. A URL with credentials
(`user:pass@`) is refused with "PR not opened: URL with credentials" —
it reaches neither the record nor the line. `view` gets `ORCH_PR_URL`
and prints JSON
`{"state":"OPEN"|"MERGED"|"CLOSED","mergeCommit":"<sha>"|null}`.
`find` gets `ORCH_BRANCH`, `ORCH_TARGET` and prints the branch's open
PR URL or nothing; without `find` a repeated release of the task reuses
the `pr_url` of this task+branch's earlier release by this coordinator
when `view` answers `OPEN`. All provider output in coordinator lines
gets the same cleanup and secret masking as command output.

GitLab via `command` (example with `glab` wrapper scripts):

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
# /home/example/tools/mr-view.sh — prints the tracking JSON
glab mr view "$ORCH_PR_URL" -F json | jq '{
  state: (if .state == "merged" then "MERGED"
          elif .state == "closed" then "CLOSED" else "OPEN" end),
  mergeCommit: .merge_commit_sha }'
```

### The PR body and the knowledge-base note

`prBody` (layered, default `BB-Thread: {thread}\n\nBB-Task: {task}`) —
the PR body template with `{thread}`, `{task}`, `{title}`
substitutions. With `threadIds: false` the template is not applied —
the body is empty (the thread id and task key are not published,
§16.6). "Whose PR" resolution on a repeated release goes by the body
marker; only two markers are parsed: `BB-Thread: thr_…` and the
previous "Источник: bb тред thr_…". A custom template spelling
`{thread}` differently ("Thread: {thread}") creates no parseable
marker — then, as with `threadIds: false`, "own PR" is determined from
the coordinator's own records of this task's earlier releases; a
foreign PR is never touched (§18.3).

`requireNote` (default `false`) at `true` makes `--kb <note>` or
`--no-kb <reason>` mandatory: release step 1 without one of the flags
refuses "a note is required: --kb … or --no-kb …".

### A chat hook

```json
"postPublish": {
  "on": "merged",
  "commands": [
    { "name": "chat",
      "command": "curl -sf -X POST https://chat.example.com/hooks/rel -d '{\"text\":\"released\"}'" }
  ]
}
```

### Event hooks (`eventHooks`)

Hooks are a separate plugin setting `eventHooks` (plugin-level, not the
`release` document; the `hooks` name is taken by git hooks): a reaction
to pipeline events, not only releases. Each event is written to the
`events` table in the same transaction as the transition that produced
it and matched against the active hooks there — a hook added or
renamed after the event does not fire for it. Pre-migration history
produces no events.

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

Hook fields: `on` — event kinds; `run` — argv without a shell (working
directory — the plugin data dir; set your own directory inside the
command); `projects` — an optional filter by the event's project;
`timeoutSec` — 120 by default; `notifyOnFail` — `false` by default, at
`true` the plugin sends the coordinator one "hook <name> failed on the
event: <result>" line per failure streak — the next one only after this
hook runs successfully. A "failure" is the `failed` and `timeout`
outcomes; `interrupted` after a plugin restart ("interrupted by
restart") counts too when enabled.

Hook names are unique (edge whitespace ignored) and must not contain
control characters (`\x00`–`\x1f`) — a duplicate or a control
character is a parse error. On ANY `eventHooks` parse error no hooks
run at all — events keep landing in the `events` journal and the trust
check still sees the changes with a broken document. A hook that does
not read stdin is normal: a write error to it is ignored and does not
crash the plugin.

Events v1: `delegation.done` (all levels including review; except
`release-audit` — its outcome is the release events),
`delegation.failed`, `delegation.stalled` (`reason`:
`stalled`/`quota`), `review.verdict` (a review delegation with a read
verdict — once per delegation; `verdict`, `blockers`),
`release.published`, `release.rejected`, `release.failed`, `pr.merged`,
`pr.closed`. A revived thread (`done` → `running` → `done`) produces
`delegation.done` again — with a new event id; write hooks idempotent
by `delegationId` where it matters.

A hook receives the v1 event JSON on stdin — `{ "version": 1, "event",
"at", "task", "project", "coordinatorThreadId", "delegationId"?,
"level"?, "route"?, "threadId"?, "reason"?, "verdict"?, "blockers"?,
"releaseId"?, "sha"?, "branch"?, "target"?, "prUrl"? }` — and the
`ORCH_EVENT`, `ORCH_TASK`, `ORCH_PROJECT` environment. For delegation
events `project` is the delegation's project; for release and PR
events — the release settings project (`settings_project_id`), which
the hook's `projects` is compared against. Execution goes through the
shared runner (the `command_runs` ledger, `source: "hook"`); `events`
and journal records are kept `retentionDays` days (30).

### Role texts, handoff and userThreadPlugins

`roleTexts` — an addition to a role's text (not a replacement): the only
keys are `orchestrator`, `executor`, `auditor`; the mandatory parts (the
`sudo`/packages/host ban, the auditor's JSON verdict) are appended by the
plugin after your text, `release-auditor` cannot be overridden, the
result must stay within 2500 characters. `handoffPath` — the handoff
path in the role texts and the compaction reminder (default
`$BB_THREAD_STORAGE/HANDOFF.md`). `userThreadPlugins` — ids of plugins
that continue a human's chat (empty by default).

```json
"roleTexts": "{\"orchestrator\": \"- Owner reports go in Russian.\"}",
"handoffPath": "/home/example/HANDOFF.md",
"userThreadPlugins": "handoff external-compact"
```

The previous author install's behavior is preserved by explicit values:
`userThreadPlugins: "handoff external-compact"`, `leaks.trailers:
"block"` in the release `defaults`, `commitIdentity`, `postPublish.
reloadPlugins: true`, `prBody: "Источник: bb тред {thread}\n\nЗадача:
{task}"` — without them the new install's defaults (an empty list,
`warn`, a neutral `prBody`) are softer than the old ones.

### Timeouts

`timing` in the `release` layers (defaults + projects, per-key merge):
`auditTimeoutMinutes` (30), `checksMinutes` (10), `prepareMinutes`
(20), `prPollMinutes` (5), `prStaleHours` (72), `prReopenWatchHours`
(72), `prErrorLimit` (3), `prCommandTimeoutSec` (60),
`commandTimeoutSec` (300), `postPublishWaitMinutes` (30 — the limit
covers only waiting: the copy lock, the command queue, the reload
postponement; a running command is bounded by its `timeoutSec`).
Watchdog timeouts — `policy.timing`: `quotaHoldMinutes` (15),
`approvalRepeatMinutes` (10), `postDispatchGraceMinutes` (5),
`bbNotifyWaitSeconds` (120), `coordinatorWatchdogEnabled` (true),
`coordinatorIdleMinutes` (5), `coordinatorMaxNudges` (3). Out-of-range values warn and fall back to
the default, not a config error.

## Limitations

- **Linux only.** Commands run through `sh` (postPublish `command`,
  custom wrappers) each in its own process group — on timeout the group
  gets SIGTERM then SIGKILL; the janitor reads `/proc/<pid>/cwd`. macOS
  and Windows are not supported.
- **External programs.** Required: `git` ≥ 2.39 (`patch-id --verbatim`,
  `merge-tree --write-tree`) and `gitleaks` — without it the release's
  machine-scan step refuses. `gh` — only with `prProvider: "github"`
  (`gh auth status` is checked at step 1); `prProvider:
  "command"`/`"none"` work without `gh`. Custom programs —
  `postPublish.commands`, `eventHooks`, `prProvider.command` — per
  configuration.
- **Executors on another machine are unsupported.** The round result
  (`result_sha`, `result_commits`, `result_dirty`), `merge` and the
  dirty-copy rescue read the worktree via local `git -C` — the
  executor's environment must live on the same host as the bb server
  running the plugin.
- **Without `/proc` the janitor removes nothing.** The "no live process
  in the copy" check (§15 item 5) reads `/proc/<pid>/cwd`; on a system
  without `/proc` (e.g. macOS) every copy stays `process-unknown` —
  passes run but nothing is removed.
- **Git ≥ 2.39.** Below that `patch-id --verbatim` does not exist: the
  janitor refuses the pass and `merge --dry-run` hints to upgrade git
  (`merge-tree --write-tree` exists since 2.38).

## Development

```
npm install
npm test               # node --test (strip-types)
npm run typecheck
bb plugin build .
```
