# bb-plugin-provider-agy

`agy` — the Antigravity CLI — as a native bb provider: a provider declaration
plus a provider bridge, the same shape `provider-claude-code` and
`provider-codex` use. No ACP in the path.

Built and verified against **bb 0.40.0** (`@get-bb/plugin-sdk` 0.4.21), which
speaks **provider bridge protocol version 2** and thread-delta grammar v3.

## Setup

Installing the plugin does not install the CLI, and bb cannot sign in for you:
the credential belongs to the machine that runs the turn. Both steps happen
**on that machine**, not in bb.

1. **Install agy.**

   ```
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   ```

   The script's own `TARGET_DIR` is `$HOME/.local/bin`, which is the first
   place this bridge looks; after that it walks `PATH`, and `AGY_PATH`
   overrides both (`resolveAgyCommand` in `src/agy-cli.ts`). Windows:

   ```
   irm https://antigravity.google/cli/install.ps1 | iex
   ```

   which installs to `%LOCALAPPDATA%\agy\bin` instead.

2. **Sign in.** Run `agy` once. There is no `login` subcommand — the first run
   opens a browser. Where it cannot, it falls back to printing the link: the
   CLI's own prompts are *"Please visit the following URL to authorize the
   application"* and *"Enter the authorization code:"*, which is the flow an
   SSH session gets. It needs a Google account with Antigravity access.

   The credential stays on that machine; bb never handles it. agy stores it in
   the OS keyring when one is reachable and **falls back to a file when one is
   not**: `~/.gemini/antigravity-cli/antigravity-oauth-token`, JSON, mode 600.
   A headless Linux host with no Secret Service gets the file — that is what
   this plugin was developed against — so treat that path as a credential when
   you back the machine up or share it.

   A host with no browser at all can skip the account entirely: set
   `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and
   export `GEMINI_API_KEY`. agy then talks to the Gemini API directly, and says
   so — "you are using the Gemini API directly with `GEMINI_API_KEY`, so there
   is no session to log out of".

3. **Check.** `agy models` lists the models on that machine, and the same list
   is what the provider offers in bb's picker. An empty picker means step 1 or
   2 has not happened on the machine bb is asking — the bridge reports the
   failure rather than hiding it, and `bb provider models agy` shows the same
   answer the picker gets.

The same three steps are rendered in bb under Settings, in this provider's own
section, so the plugin explains itself where it is configured. `server.ts`
also declares the `signInHint` / `expiredHint` / `installUrl` strings bb shows
on its own surfaces when a host has no working agy.

## Before you install it

**Threads on this provider run without approval prompts.** agy's stream-json
has no approval back channel — there is no message the bridge could answer a
permission request with — so the bridge declares a single permission mode,
`full`, and starts agy with `--dangerously-skip-permissions`. A thread on agy
reads, writes and runs commands in its workspace directory without asking
first. Give it a directory you would let an unattended process edit. This is a
property of the CLI's dialect, not a default this plugin could flip; if agy
grows a `control_request`/`control_response` channel, the bridge can declare
the narrower modes and this paragraph goes away.

**What the bridge writes down.** `bridge.log`, in the plugin's data directory,
records the agy command line, `HOME`, `PATH` and agy's stderr — the daemon
captures a bridge's stderr nowhere, and without that log "agy did not report a
conversation id" is an unfalsifiable claim. The **values** of environment
variables passed to a thread are never written to it: only argv is logged, and
the passthrough travels in the child's environment. The log stays on the
machine that ran the turn; this plugin sends nothing anywhere.

Both paragraphs are rendered in bb under Settings too, below the setup steps
(`app.tsx` → `src/AgySafetySection.tsx`), so they are visible where the
provider is configured and not only here.

## Layout

| file | what it is |
| --- | --- |
| `server.ts` | the provider declaration (`bb.providers.register`) |
| `host.ts` | the `bb.host` artifact; exports `experimental_providerBridge` |
| `src/provider-bridge.ts` | the bridge: JSON-RPC handlers, session/turn state, agy → `thread/delta` translation |
| `src/agy-cli.ts` | everything that knows agy's argv and its NDJSON dialect |
| `app.tsx` | the `bb.app` frontend; registers the provider mark inline and the settings notice |
| `src/AgySafetySection.tsx` | that section: the setup steps, then what a turn may do without asking and what gets logged |
| `icons/agy.svg` | the same mark as a file, served to clients as the provider `logoUrl` |
| `harness.mjs` | protocol suite against the real agy (see below) |
| `harness-fake.mjs`, `harness-steer.mjs`, `harness-rebuild.mjs`, `harness-artifact.mjs` | the quota-free suites, driven by `fake-agy.mjs` / `fake-agy-artifact.mjs` |
| `harness-errors.mjs`, `fake-agy-errors.mjs` | the error-surfacing suite: failed tool steps, stderr banners, turn-less rejects, the stale quota-residue replay |

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

## Steering: one queue, owned by the bridge

agy's stream-json is one turn per stdin line, so there is no way to reach the
model inside a running turn. The bridge therefore declares
`steerMode: "queue"` and honours it literally: a `turn/steer` that names a live
turn is **accepted** and becomes the next turn of the session. Refusing it (what
this bridge did before) loses the request — the runtime drops a rejected steer
on the bridge's own `staleTurn` hint, and the text the user typed goes nowhere.

The queue is the bridge's, not the child's stdin buffer:

- only the **head** of the queue is written to agy, so a queued turn cannot
  race the turn ahead of it however agy buffers its input;
- a queued turn is announced (`turn.open`, then `input.accepted` carrying its
  own `providerTurnId`) at the moment it reaches the head, so no delta ever
  names a turn agy has not been asked to run;
- the same holds for a second `turn/start` arriving mid-turn, and it is what
  lets an artifact-refusal re-drive stay safe with work queued behind it.

Only a steer whose turn is already gone is refused, and then with the typed hint
the runtime keys on rather than error text:

```
{"code":-32001,"message":"turn … is not live on thread …",
 "data":{"recovery":{"kind":"staleTurn","message":"…","retryable":false}}}
```

What a steer still cannot do is change the turn it was aimed at: that turn runs
to its own answer first. `harness-steer.mjs` is the proof for all of it.

## When agy dies and the conversation does not

agy is a child process with its own timeouts, and it can be gone while the
conversation it was running is still on disk. The next turn rebuilds a child
against that same `conversation_id` rather than failing the thread — and the
rebuild is a **new provider session**, even though its id is the old one:

- `session/replaced` goes out **before** the spawn, so nothing the replacement
  says can arrive ahead of the news that it exists (`contextLost: false`: the
  conversation survived, only the process did not);
- the replacement's `init` re-announces `thread/identity` and emits
  `session.reset`, because the runtime's assembler keeps item and turn maps,
  settled ids and open streams until a reset says to drop them — an unchanged
  conversation id is not a reason to assemble a new process's items into the
  old id space;
- the turn that triggered the rebuild waits in the bridge's `pending` queue
  until that announcement, so no `turn.open` is ever emitted into an id space
  the runtime is about to drop;
- the usage baseline restarts with the child: agy counts tokens cumulatively
  per process, so carrying the old reading over would clamp every later turn's
  `last` to zero.

`harness-rebuild.mjs` is the proof: a first turn whose fake agy exits the
moment it has answered, then a second turn that can only run on a rebuilt
child.

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
still fails. The tool error is not hidden: it travels as the `provider/raw`
step that carried it, it is surfaced to the thread as a scoped `provider.error`
(see below), and the bridge log names every turn it let through.

Editing existing files never hits this: `view_file` + `replace_file_content`
comes back `SUCCESS`.

## Errors reach the thread

agy reports a real failure (quota, auth, an overloaded backend) through several
channels at once, and each used to be handled only for its own bookkeeping —
a failed tool step was remembered for the recovered-turn judgement, stderr was
logged, and a turn-less `ERROR` result with a null status was dropped as noise.
None of that put the words in front of the reader.

A single path (`reportError`) now turns error text from ANY of those channels
into a thread-visible `provider.error`:

- a `tool` step that settles `ERROR` is surfaced even when the turn itself
  recovers and completes;
- agy's **stderr** is line-reassembled (data chunks do not respect line
  boundaries) then surfaced; its `warning:`-prefixed protocol chatter is logged
  but not surfaced; ANSI paint is stripped;
- a stdout line that is not JSON at all and reads like an error is surfaced;
- a turn-less `ERROR` result before identity fails the session and the
  `thread/start` / `thread/resume` reply names the message — nothing may be
  emitted before the child announced itself, so this is the one path that
  reports through the start reply rather than a thread delta.

The `⚠ Individual quota reached. … Resets in 8m11s.` notice arrives with its
`rate-limit` category, so bb treats it as the rate-limit error it is. The same
message reaching the thread on two channels within one turn is reported once
(per-turn dedup); the next turn is free to report it again.

### The quota-residue replay (agy 1.1.27)

Once a conversation has been rejected for quota, agy re-attaches THAT verbatim
error — frozen `Resets in X` and all — to the result of every later turn in
that conversation, even when the model just answered normally. Reproduced live
on real conversation `44069b14-fdd2-4404-bf99-08a1825cbceb`: its genuine
`Resets in 1h13m29s.` text from 18:36 kept showing up verbatim at 21:56 and
22:18, after the window had long since opened — and `bb.db` shows that even the
conversation's very first reject (18:32) landed only after several completed
assistant items had streamed.

The discriminator is the reply, not the text: a turn whose `agent_response`
step ran to `DONE` with text streamed real content, so an `ERROR` result on top
of it is agy talking about the conversation's history, not about this turn.
Such a result settles **completed** on the content that streamed, and the stale
banner is not shown again. A turn whose reply never completed still fails
honestly, new countdown or not — proving them apart uses only what this turn
streamed, so the rule is stable across sessions, plugins reloads and reboots:
there is no first-turn-replays-once edge case, and recovery is unconditional
and immediate.

`node harness-errors.mjs` drives all five shapes against `fake-agy-errors.mjs`,
no account, no network, no quota.

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

`node harness.mjs [model]` drives the **built** `dist/host.js` in-process and
checks the public protocol-v2/thread-delta rules plus the agy-specific ones:

```
rpc/unknown-method, rpc/invalid-params, rpc/non-json-ignored,
rpc/response-not-request, handshake/initialize, model/list,
session/start-identity, ordering/identity-precedes-deltas, session/reset-first, turn/lifecycle,
item/opens-before-delta, stream/deltas-arrive, item/settles-with-text,
usage/reported, deltas/schema-valid, steer/queued-while-active,
steer/runs-after-the-turn-it-steered, steer/stale-turn-refused,
stop/release-not-interrupted, session/resume
```

Pass a model agy currently lists (`agy models`); the argument is not optional
in practice, because agy retires model ids between releases.

20/20 pass on agy 1.1.23 with `gemini-3.7-flash-low`. The two steer rules that
need a live turn report **skip** rather than fail if agy settles the steered
turn before the steer goes out — a real CLI cannot be made slow on demand, and
`harness-steer.mjs` proves the same rules deterministically.

`node harness-fake.mjs` replays the dialect from
`fake-agy.mjs` — **no account, no network, no quota** — with four streamed
chunks per turn, so a real one-token answer cannot hide a bridge that forwards
only the last piece. 7/7 pass: every chunk forwarded as its own
`item/agentMessage/delta`, one item per turn, the item settling with the full
text, two turns down one session with distinct turn ids, and usage where
`total` is cumulative and `last` is the turn's own slice.

`node harness-rebuild.mjs` proves the rebuild path, which needs a child that
dies on cue: a prompt containing `[[die]]` makes `fake-agy.mjs` answer in full
and then exit, the way a crashed or timed-out agy leaves a live conversation
behind. 12/12 pass — the crash settles nothing it should not, the next turn
announces `session/replaced` before the spawn, the replacement re-announces
`thread/identity` and `session.reset`, every delta of the rebuilt turn lands
after that reset, the same conversation gets the turn's text, and usage is
counted from the new child's own zero.

`node harness-steer.mjs` proves the steer path with the same fake, and it is
the one suite that can: a prompt containing `[[hold]]` makes `fake-agy.mjs`
stream its first chunk and then stop until the harness releases it, so the two
steers it sends are provably aimed at a turn that is still running. 13/13
pass — both steers accepted (never `NO_ACTIVE_TURN`), neither announced nor
written to agy's stdin while the held turn owns it, then three turns settling
in order with each `input.accepted` naming its own turn, and a steer for the
settled turn refused with the typed `staleTurn` hint.

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
- **Mid-turn injection.** `turn/steer` is honoured as `steerMode: "queue"` —
  accepted while a turn is live and run as the next turn (see below) — but agy
  has no channel for reaching the model *inside* a running turn, so the steer
  cannot change what the current turn does. That needs agy support.
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

`node harness-errors.mjs` proves the error paths with no account and no quota —
19/19: a failed tool step inside a turn that then completes reaches the thread
exactly once per turn with its `rate-limit` category, the ⚠ banner on stderr
reaches the thread while a `warning:` line beside it does not, a turn-less
`ERROR` result — with either an explicit or a missing `status` — fails the
session with the message named, and the quota-residue replay settles answering
turns completed on the reply that streamed while a no-reply turn with a fresh
countdown still fails and surfaces.
