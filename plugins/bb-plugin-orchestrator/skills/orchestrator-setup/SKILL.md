---
name: orchestrator-setup
description: Set up the orchestrator plugin together with the user — their providers and subscriptions, level routes and fallback chains, presets, the policy JSON, git rules for executors. Use when the plugin reports needs-configuration or the user asks to configure delegation.
---

# Setting up orchestrator

There are no ready-made model bundles in the plugin: you choose what sits on each level together with the user. Do not invent models — take them only from the output of the commands below.

## Procedure

1. **Ask the user** which subscriptions and providers they have and what they are reluctant to spend: which models may run in the background and which — only for the main work and review.
2. **See what is actually available**: `bb provider list`, then `bb provider models <id>` for each suitable provider. Models and reasoning levels — only from this output. Existing presets — `bb tasks preset list`; suitable ones can be used as is.
3. **Propose levels and fallback chains** — show a table and wait for agreement:
   - `complex` — hard: architecture, root-cause analysis, multi-file features, migrations, refactoring;
   - `medium` — ordinary features and tests against a clear spec;
   - `simple` — mechanical edits, documents, data gathering;
   - `review` — checking specs before dispatch and results after; read-only.
   A level can have a route chain: when the first fails (quota, stall) the watchdog takes the next one. For `complex` and `review` auto-reissue is usually off (`autoFallback: false`) — the coordinator decides about reissue.
   There can be several review levels — give the level `"role": "auditor"` (e.g. `review-complex`, `review-medium`, `review-simple`); without the field the level is an executor one, and the name `review` still counts as auditor. Binding complexity to review — `"reviewByLevel": {"complex": "review-complex", …}`: `delegate --level review` then picks the auditor level itself by the task's last execution.
4. **Create the missing presets**:
   `bb tasks preset create --name <preset> --provider <id> --model <id> --reasoning <level> --permission full --environment worktree [--instructions <text>]`.
   In executor presets' `--instructions` — the executor contract (work in your own copy, report with branch and SHA, no push or PR); for review-level presets — the read-only contract (change nothing, commit nothing) plus the requirement to end the report with the JSON line `{"verdict":"OK"|"CHANGES","blockers":<number>}` — the release pipeline reads it.
   Executor-level presets must create a worktree (`--environment worktree`): without its own copy an executor cannot work in isolation — the validator warns when a preset's environmentKind is not `new-worktree`.
5. **Ask about the git rules** of the user's repository: base branch and its sync command, working-branch naming, commit signature, bans. The text (≤ 1500 characters) goes to executors as the first "Working with git" section on every dispatch and reissue. Write it: `bb plugin config orchestrator set gitInstructions '<text>'`; an empty string disables the section.
6. **Write the policy** and verify it:
   `bb plugin config orchestrator set policy '<json>'`, then `bb orchestrator policy validate`.
   Format: `version: 1`, `levels.<name> = { description, role?, chain: [<route>...], autoFallback }`, `routes.<name> = { preset, provider, quotaGroup?, quotaPatterns?, firstResponseSeconds? }`, optional `reviewByLevel` (execution level → its auditor level), `limits`, `firstResponseSeconds` (30–600), `maxRunSeconds` (≥ 300). An empty or invalid policy — the plugin goes `needs-configuration` and `delegate` refuses calls. After editing settings, reload the plugin so the status refreshes.
   Routes on providers with a long cold start (1.5–3 minutes to the first reply) need `routes.<name>.firstResponseSeconds` ≈ 300 — otherwise the watchdog takes the warm-up for a stall. For executors on such providers, add an absolute-paths rule to `gitInstructions` or the dispatch instructions if the provider requires it.
7. **Disable subagents on executor providers**: `bb plugin config <provider-plugin>` — `subagentsDisabled` must be `true`. An executor that spawns subagents outside the dispatch loses its watchdog and binding.
8. **Suggest branch protection on the hosting** (when using `release`): the shared pre-push hook protects against forgetfulness (an accidental `git push` bypassing the pipeline), not against intent — an agent of the same user can issue a marker itself. Where a hard gate is needed (main/dev, public repositories), suggest the user enable hosting-side branch protection (direct-push ban, required checks) — the user decides.
9. **Set up publishing** (when using `release`, spec orchestrator-release §6) — walk the user through three places in the `release` document:
   - `commitIdentity` — the allowed commit signature (`"Name <email>"` or `"repo"` — from the repository config). Without it the scan only warns about signatures and `bb orchestrator status` prints "no commit author configured" — suggest setting it explicitly, otherwise a foreign signature does not block publishing.
   - `allowedTrailers`/`allowedEmails` — which trailers (`Co-Authored-By`, `Signed-off-by`, …) and addresses/domains do not count as author-identity leaks. A trailer outside the list is handled by `leaks.trailers` (default `warn` — set `"block"` to forbid); a personal email always blocks.
   - `leaks` — the strictness of categories 3–4: `machine` and `bbIds` (`block`/`warn`, default `block` for a public project and `warn` for a private one), `trailers` (default `warn`), `allow` — paths where mentions are fine. A project's `leaks` merges with `defaults.leaks` per key.
   The rest follows the schema — `target`, `checks`, `docsMap`, `postPublish`, `prProvider`, `prBody`, `requireNote`, `timing`. Verification: `bb orchestrator status` and a trial publish on a test branch.
10. **Suggest enabling the janitor** (spec §15): it removes merged worktrees, `bb/` branches, and executor threads, and reports abandoned ones. Off by default.
    `bb plugin config orchestrator set janitor '{"enabled": true, "mode": "report"}'` — the first pass only reports, deletes nothing. Look at `bb orchestrator janitor report`; if the report looks sane, switch to deletion:
    `bb plugin config orchestrator set janitor '{"enabled": true, "mode": "apply"}'`.
    Fine tuning (JSON, optional keys): `afterMerge` (delay after merging before cleanup, `15m`+, default `10h`), `abandonedAfter` (idle threshold for the "abandoned" report, `1d`+, default `10d`), `intervalMinutes` (≥ 15, default 60), `excludeProjects` (bb project ids another janitor handles), `protectedBranches` (default `["main","master","dev"]`), `deleteBranches` (default `true`), `scope` (`workers` — executor environments only, the default; `all` — also the user's root chats). Only what is fully on `origin` and clean is deleted; unmerged and dirty items go only into the report and the daily coordinator message. An off-schedule pass — `bb orchestrator janitor run`, dry — `bb orchestrator janitor run --dry-run`.

Verify the result: `bb orchestrator policy show` (policy and warnings), `bb orchestrator instructions` (the rule the coordinator will see), and — if the janitor is on — `bb orchestrator janitor report`.
