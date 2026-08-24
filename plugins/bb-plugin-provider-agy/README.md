# bb-plugin-provider-agy

`agy` — the Antigravity CLI — as a native bb provider: a provider declaration
plus a provider bridge, the same shape `provider-claude-code` and
`provider-codex` use. No ACP in the path.

Built and verified against **bb 0.39.0** (`@get-bb/plugin-sdk` 0.4.8), which
speaks **provider bridge protocol version 1** and the `thread/event` grammar.
The `thread/delta` / grammar-v3 protocol described on bb's `main` branch is a
later, unreleased revision — a v3 bridge would be refused by this bb.

## Layout

| file | what it is |
| --- | --- |
| `server.ts` | the provider declaration (`bb.agents.experimental_registerProvider`) |
| `host.ts` | the `bb.host` artifact; exports `experimental_providerBridge` |
| `src/provider-bridge.ts` | the bridge: JSON-RPC handlers, session/turn state, agy → `thread/event` translation |
| `src/agy-cli.ts` | everything that knows agy's argv and its NDJSON dialect |
| `app.tsx` | the `bb.app` frontend; registers the provider mark inline |
| `icons/agy.svg` | the same mark as a file, served to clients as the provider `logoUrl` |
| `harness.mjs` | offline protocol suite (see below) |

## agy's stream-json dialect (confirmed against agy 1.1.19)

The discriminator is **`event`**, in both directions. This is agy's own
dialect, not the Claude Code SDK shape it resembles.

Output:

```
{"event":"init","conversation_id":"…","init":{"model":…,"cwd":…,"tools":[…],"permission_mode":…}}
{"event":"step_update","step_update":{"conversation_id":…,"step_index":N,"state":"ACTIVE"|"DONE",
   "step_type":"user_input"|"checkpoint"|"agent_response","text_delta":"…","usage":{…},"duration_seconds":…}}
{"event":"result","result":{"conversation_id":…,"status":"SUCCESS"|"ERROR","response":"…","error":"…",
   "num_turns":N,"usage":{"input_tokens":…,"output_tokens":…,"thinking_tokens":…,
   "cache_read_tokens":…,"total_tokens":…}}}
```

Input — **the schema this plugin's first task was to establish**:

```
{"event":"user","message":{"role":"user","content":"say hi"}}
{"event":"user","message":{"role":"user","content":[{"type":"text","text":"say hi"}]}}
```

Both `content` forms work. The errors agy returns for the near misses are what
pinned it down:

| line sent | agy's answer |
| --- | --- |
| `{"type":"user",…}` | `stream input message is missing the "event" field` |
| `{"event":"user_message"}` | `warning: ignoring unsupported stream input message event "user_message"` |
| `{"event":"user"}` | `stream input "user" message is missing the "message" field` |
| `{"event":"user","message":{"role":"user"}}` | `stream input "user" message has no content` |

Facts that shape the bridge:

- **One turn per stdin line**, run strictly in order; the session stays alive
  between them, keeps one `conversation_id`, and survives being idle (checked:
  25 s idle then a prompt still runs).
- `text_delta` is **incremental** — append, never a cumulative snapshot.
- `result.usage` is **cumulative for the conversation**; a step's `usage` is
  that turn's. The bridge forwards the cumulative value as `total` and the
  difference as `last`.
- `--print` **requires a value**: `agy --print --output-format stream-json`
  eats the next flag as the prompt. Use `--print=`.
- **`--model <id>` and `--effort` are mutually exclusive** when the model id
  already names an effort (all of them do: `gemini-3.7-flash-high`, …). Passing
  both is `invalid model selection …`, exit 1, with the explanation on
  **stdout** as an `ERROR` result — nothing on stderr. This bridge only sends
  `--effort` when no model was named, and reports a turn-less `ERROR` result as
  a session failure so the cause reaches the thread instead of vanishing.
- `agy models`/`agents` have no `--output-format json` in 1.1.19 (the changelog
  promises one; the binary answers `flags provided but not defined`), so
  `model/list` parses the `id<TAB>Display Name` text.
- There is no back channel in stream-json for tool approvals (no
  `control_request`/`control_response` in the binary), so phase one runs
  `--dangerously-skip-permissions` and declares `permissionModes: ["full"]`.

## The workspace (`--add-dir`) and agy's recovered tool errors

Two things about agy 1.1.19 that the bridge has to carry, both confirmed by
driving the binary directly:

**agy takes its workspace from `--add-dir`, never from the process cwd.**
Spawned in a directory it was not given, it still answers and still writes
files — into `~/.gemini/antigravity-cli/scratch/<name>/` — and any
`write_to_file` aimed at a real project path fails the turn with

```
declaring permissions: cortex tool write_to_file: convert tool call for
permissions: model output error: invalid tool call error (invalid_args)
<path> is not a valid artifact path; artifacts must be in
/home/<user>/.gemini/antigravity-cli/brain/<conversation-id>/
```

The same prompt ("создай файл hello.txt") writes to
`~/.gemini/antigravity-cli/scratch/hello/hello.txt` without the flag and to the
thread's directory with it. So the bridge passes `--add-dir <thread cwd>` on
every spawn; `cwd` on `spawn()` alone is not enough. Being a git repo makes no
difference either way.

**agy reports a turn's last tool error as the turn's own error, even when the
model retried and the work landed.** The common case is `write_to_file`: the
first call comes back with the artifact-path error above, the second call — same
tool, same `TargetFile` — settles `DONE` and the file appears, the response is
complete, and `result.status` is still `ERROR` carrying the first call's message
verbatim. Failing the turn on that ends a bb thread on work that succeeded, so
`handleResult` settles it as completed when the result error is verbatim a tool
error this turn recovered from (a later tool step reached `DONE`); anything else
still fails. The tool error itself is not hidden — it travels as the
`provider/raw` step that carried it, and the bridge log names every turn it let
through.

Editing existing files never hits this: `view_file` + `replace_file_content`
comes back `SUCCESS`.

## The icon

`icon` on the declaration takes the same two shapes as `bb.branding.icon`: a
named host glyph (`"Zap"`) or a plugin-relative `.svg` path. **A glyph name
carries no bytes, so it produces no `logoUrl` at all** — which is why `agy`
first appeared in the picker as a letter tile. A path becomes
`/api/v1/system/providers/agy/logo`, drawn through `<img>`.

Both routes are wired, because bb resolves a provider icon in this order:
a plugin-registered `app.slots.experimental_providerIcon` component, then its
vendored brand maps, then the server `logoUrl`. So `app.tsx` renders the mark
inline (crisp, no fetch) and `icons/agy.svg` stays as the fallback for when the
frontend has not booted, is disabled, or fails. The palette is explicit rather
than `currentColor`: an `<img>` SVG is a separate document where `currentColor`
is black, and a four-colour mark has no single tint to inherit anyway.

The mark is original artwork — a double chevron for the upward pull the name
claims, in four mid-tone hues that carry on both themes.

## Verification

`node harness.mjs [model]` drives the **built** `dist/host.js` in-process. bb
0.39's conformance kit is private to the monorepo (`@bb/provider-bridge-protocol/conformance`)
and is not published in SDK 0.4.8, so the harness reimplements its scenarios
under the same rule names and adds the agy-specific ones. 17/17 pass:

```
rpc/unknown-method, rpc/invalid-params, rpc/non-json-ignored,
rpc/response-not-request, handshake/initialize, model/list,
session/start-identity, ordering/identity-precedes-events, turn/lifecycle,
item/opens-before-delta, stream/deltas-arrive, item/settles-with-text,
usage/reported, events/schema-valid, steer/typed-refusal,
stop/release-not-interrupted, session/resume
```

`AGY_PATH=$PWD/fake-agy-shim node harness-fake.mjs` replays the dialect from
`fake-agy.mjs` — **no account, no network, no quota** — with four streamed
chunks per turn, so a real one-token answer cannot hide a bridge that forwards
only the last piece. 7/7 pass: every chunk forwarded as its own
`item/agentMessage/delta`, one item per turn, the item settling with the full
text, two turns down one session with distinct turn ids, and usage where
`total` is cumulative and `last` is the turn's own slice.

End to end in bb itself:

```
bb thread spawn --project <id> --provider agy --model gemini-3.5-flash-low \
  --permission-mode full --prompt "count from 1 to 20, one number per line"
bb thread output <thread>
```

## Not done yet

- **Tool approvals.** Needs a back channel agy's stream-json does not have; until
  then only `permissionModes: ["full"]`.
- **Tool-call rows.** agy's `step_update` only reports `user_input`,
  `checkpoint` and `agent_response`; if agy gains per-tool steps they arrive as
  `provider/raw` (`coverage: "unknown"`) and are visible in debug UI rather
  than silently dropped.
- **Steering** is refused with `NO_ACTIVE_TURN`, so bb turns a steer into the
  next turn — which agy runs in order. Real mid-turn injection needs agy support.
- **Fork, archive, rename, manual compaction** are all declared off.
- **Reasoning levels** are folded into agy's `low|medium|high`, and because
  every model id already names one, the picker's level is effectively ignored
  when a model is selected.

## `write_to_file` and `ArtifactMetadata` (agy 1.1.19)

`write_to_file` is two tools behind one name. Called with
`TargetFile`/`CodeContent` it writes into the workspace. The moment the model
*also* emits an `ArtifactMetadata` field, agy validates `TargetFile` against the
conversation's artifact directory and the turn dies before the tool runs:

```
declaring permissions: cortex tool write_to_file: convert tool call for
permissions: model output error: invalid tool call error (invalid_args)
<project path> is not a valid artifact path; artifacts must be in
~/.gemini/antigravity-cli/brain/<conversation>/
```

What it is **not** about, all four ruled out by measurement:

* `--add-dir` — the refused turn was spawned with `--add-dir` on the project
  root (pid 463863: `--add-dir /home/ubuntu/work/sandbox`) and the target was
  `/home/ubuntu/work/sandbox/bb-addons/.../QuickFavoritesAction.tsx`, inside it;
* the process cwd — it was the project root too (`/proc/463863/cwd`);
* worktrees — the thread ran in `Working locally`, not in a worktree;
* the file being new — the refused call had `Overwrite: true` on a file that
  existed, and a fresh conversation creates
  `deep/nested/src/Foo.tsx` happily.

The refused args and a successful one differ by exactly one field
(conversation 693cd8c3 step 109 versus 14cd35c2 step 3):

```
refused:  {"ArtifactMetadata":{…}, "CodeContent":…, "Overwrite":true, "TargetFile":"/home/ubuntu/work/sandbox/…/QuickFavoritesAction.tsx", …}
accepted: {                        "CodeContent":…, "Overwrite":true, "TargetFile":"/home/ubuntu/work/agyfix/deep/nested/src/Foo.tsx",   …}
```

`--mode accept-edits` does not help; seven of the conversations on this host
have hit it, always on `.tsx` files. The model does not learn from the refusal:
thr_54vswmyikz produced the identical refusal on three consecutive user turns.

Twice measured, the refused call was a **duplicate**: the model wrote the file
correctly and then emitted the artifact-shaped call that killed the turn, so the
work was already on disk. That is what the bridge leans on:

1. one re-drive per refused turn, telling the model to look at the named file
   and to say so if it is already right (`writeRetryNudge`);
2. a turn that streamed an answer settles as **completed** — agy is reporting
   one rejected tool call as the turn's status, and failing it would kill a live
   thread over finished work;
3. a turn that answered nothing still fails, with the cause spelled out;
4. every later turn of that session carries a one-line rule against
   `ArtifactMetadata` (`WRITE_GUARDRAIL`).

`node harness-artifact.mjs` drives all three shapes against a fake agy, for free.
An existing thread keeps the bridge build its own worker process was started
with, so the fix reaches a running thread only after that session restarts.
