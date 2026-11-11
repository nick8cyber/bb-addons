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
