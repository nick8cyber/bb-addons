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
  index against double dispatch), runs `bb tasks dispatch`, attaches the
  thread as a hidden child with `parentNotifications=auto`, best-effort
  `mode=bypass` for `permissionMode=full` presets, marks `running`, and
  comments «Раздано» on the task.
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
  `core.hooksPath` and installs a wrapper under EVERY `githooks(5)`
  name (`pre-push` is the orchestrator gate; the rest are copies of
  `chain`, which execs the repo's own `.git/hooks/<name>` — only when
  it is executable, like git itself). The shared `pre-push` is a
  **forgetfulness guard, not a hard gate**: it stops an accidental
  `git push` via a one-time `push-token-*.json` binding branch+sha,
  but an agent running as the same user could write the token itself —
  for a hard gate use branch protection on the hosting (required
  checks); `orchestrator-setup` offers it. The installer takes the
  token dir from `bb orchestrator hooks-dir` (the plugin's data dir)
  — override with `--hooks-dir`. After a plugin update re-run
  `hooks/install.mjs` — `release` refuses `hook-stale` when any
  expected wrapper is missing or differs from the plugin's.
  `threadIds` (default on) keeps the «Источник: bb тред thr_…» line in
  PR bodies and exempts `thr_…` from the bb-ids leak rule; off — no
  «Источник» line and every `thr_…` is a `leaks.bbIds` finding.
  `allowedTrailers` / `allowedEmails` (§17.3 С6) exempt matching
  commit trailers (e.g. `Co-Authored-By`) and e-mail addresses/domains
  from the machine scan's `foreign-bot-trailer` / `personal-email`
  rules.
- **Reconcile** (§7): on service start and every 60 s — re-reads threads
  and events after `last_seq`, finishes half-done §4.4–4.6 steps, relinks
  `dispatching` rows via `bb tasks threads` or drops them, survives
  restarts without duplicate reissues. `bb orchestrator reconcile` runs
  a pass immediately.
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
  not, the role carries no text (agy pending PLUG-139; `acp-devin`
  restores instructions after compaction via `provider-devin`).

## Настройка

No bundled model sets — setup is a walkthrough the agent runs with the
user via the `orchestrator-setup` skill (§2.1): inventory the providers,
map presets onto levels and fallback chains, write the policy, validate.

- `policy` (multiline JSON, §2) — levels, route chains, limits, quota
  groups. Empty or invalid → `needs-configuration`, `delegate` refuses.
- `gitInstructions` (§2.2, ≤ 1500 chars) — the «Работа с git» section
  prepended to every dispatch's `--instructions`; empty disables it.
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

## Development

```
npm install
npm test               # node --test (strip-types)
npm run typecheck
bb plugin build .
```
