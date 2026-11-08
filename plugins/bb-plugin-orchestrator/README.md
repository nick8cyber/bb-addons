# bb-plugin-orchestrator

Policy-driven delegation of `bb tasks` to executor threads (spec:
`docs/specs/orchestrator.md`, ADR-0015). MVP scope — the watchdog, roles,
and reconcile arrive in later stages.

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
- **CLI**: `delegate`, `status`, `show`, `cancel`, `policy show|validate`,
  `instructions`, `reconcile` (watchdog-stage stub).
- **`injectInstructions`** setting (default on): off silences every
  plugin-generated text; tools stay.

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
