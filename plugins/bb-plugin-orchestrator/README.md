# bb-plugin-orchestrator

Policy-driven delegation of `bb tasks` to executor threads (spec:
`docs/specs/orchestrator.md`, ADR-0015). MVP scope — thread roles arrive
in a later stage.

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
  reach only coordinator threads (no parent + no executor markers, §3);
  `delegate` re-checks the caller at call time (`not-a-coordinator`).
- **Watchdog** (background service, §5): first-response window
  (`firstResponseSeconds`) → `stalled` + stop; quota detection
  (`errorInfo.category`, then text patterns) → `quota`, 15-minute
  `route_holds` on the quota group; `done`/`cancelled`/`failed`/`approval`/
  `timeout` outcomes; auto-reissue down the level chain when
  `autoFallback` allows (one transaction, `reissue_of`, reuses the §4
  dispatch steps); coordinator messages via `threads.send`
  `queue-if-active` prefixed `[orchestrator]`, task comments throughout.
- **Reconcile** (§7): on service start and every 60 s — re-reads threads
  and events after `last_seq`, finishes half-done §4.4–4.6 steps, relinks
  `dispatching` rows via `bb tasks threads` or drops them, survives
  restarts without duplicate reissues. `bb orchestrator reconcile` runs
  a pass immediately.
- **CLI**: `delegate`, `status`, `show`, `cancel`, `policy show|validate`,
  `instructions`, `reconcile`.
- **Coordinator skills**: `orchestrator-coordinator` (full coordinator
  playbook, §3) and `orchestrator-setup` (§2.1 setup walkthrough) ship in
  `skills/` and are selected for coordinator threads — setup always,
  coordinator only when `injectInstructions` is on.
- **`gitInstructions`** setting (§2.2, multiline, ≤ 1500 chars): a
  «Работа с git» section prepended to every dispatch's `--instructions`,
  reissues included. Empty disables the section; over-limit is refused by
  the setting schema and flags `needs-configuration` if already stored.
- **`injectInstructions`** setting (default on): off silences every
  plugin-generated text; tools and `orchestrator-setup` stay.

## Notes

- `needs-configuration` clears only on plugin reload (SDK V1): after fixing
  `policy`, run `bb plugin reload orchestrator` to re-check.
- Warnings about missing presets appear in the log, `policy show`, and
  `policy validate`; the check runs at validate/first delegate/in the
  background — never synchronously at plugin load.

## Development

```
npm install
npm test               # node --test (strip-types)
npm run typecheck
bb plugin build .
```
