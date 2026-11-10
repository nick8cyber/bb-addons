# bb-addons

Independently usable plugins and themes for [bb](https://getbb.app).

Install any of them straight from this repository:

```bash
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin ru
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin favorite-models
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin provider-agy
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin pi-gateways
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin speak
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin compact-ui
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin tasks-pro
```

Or from a local clone — handy while developing, since bb reloads a `path:`
install in place:

```bash
bb plugin install ./plugins/bb-plugin-ru
```

## Plugins

### `ru` — Русификатор

Translates the bb interface into Russian: a 2337-entry dictionary, exact-match
only, so conversations, code, diffs and anything you type are left alone. A
globe button in the sidebar footer switches the language in place.

Coverage measurement and the procedure for extending the dictionary are in
[plugins/bb-plugin-ru/README.md](plugins/bb-plugin-ru/README.md).

### `favorite-models` ⭐

Star any provider's model and it gets pinned to the top of the picker, with a
quick-switch menu in the composer. Favourites are grouped per provider, and the
store is normalised on read — provider ids are canonicalised so entries cannot
end up filed under a provider that does not exist.

Details in
[plugins/bb-plugin-favorite-models/README.md](plugins/bb-plugin-favorite-models/README.md).

### `provider-agy` — Antigravity

Runs bb threads on `agy`, the Antigravity CLI, as a **native provider** rather
than through ACP: a provider declaration plus a provider bridge, the same shape
the built-in `provider-claude-code` and `provider-codex` use. Requires `agy` on
PATH and an authenticated `~/.gemini`.

What it handles on its own (details in the plugin README):

- **Account pool.** Several Google accounts, one agy HOME each; a thread is
  pinned to the least-used free account, and on a quota limit the turn moves
  to a free sibling with a compact handoff.
- **Accounts Google refuses.** "Not eligible for Antigravity" parks the
  account (2 h for a location refusal, 24 h when verification is required,
  with the verification link in `bridge.log`) and re-runs the turn on a free
  sibling; a breaker stops parking after 3 accounts in 10 minutes, so a
  network fault cannot park the whole pool.
- **Transient failures are retried by bb itself.** Google's own 5xx errors
  and a frozen agy (stall-kill with no tool running) reach bb tagged so its
  builtin `provider-retry` re-runs the turn (about 1 minute, doubling, up to
  4 retries) instead of the thread standing still until someone types.
- **Stall watchdog.** 15 minutes of silence during a turn with no tool
  running, 2 hours with a tool in flight (`AGY_STALL_KILL_MS` /
  `AGY_TOOL_STALL_MS`); the clock starts when the turn is handed to agy.
- **Compaction.** bb's `/compact` runs as agy's own compaction. When Google
  refuses it, the bridge compacts by hand: the agent summarizes the old
  conversation and the thread continues on a fresh one that starts from that
  summary (or, without one, from a read-only look at the thread's own recent
  history); failing that, it goes back to the old conversation.

Behaviour contract and decisions:
[spec](docs/specs/provider-agy-recovery.md),
[ADR 0002](docs/adr/0002-provider-agy-failure-recovery.md),
[ADR 0003](docs/adr/0003-provider-agy-compaction-fallback.md).

The README also documents a real trap worth reading before writing any provider
bridge: how a refused `write_to_file` argument silently costs you a whole run —
[plugins/bb-plugin-provider-agy/README.md](plugins/bb-plugin-provider-agy/README.md).

### `provider-devin` — Devin (SWE-2)

Runs bb threads on Devin's SWE-2 as a native `acp-devin` provider: an ACP
bridge with a `devin` dialect, plus hooks that return bb thread rules after
compaction, hide executor threads and pin them to the coordinator. Requires
the `devin` CLI and its hook set installed.

Details in
[plugins/bb-plugin-provider-devin/README.md](plugins/bb-plugin-provider-devin/README.md).

### `pi-gateways`

Offers the free models of **OpenCode Zen** and the **Kilo Code gateway** to the
`pi` provider over their HTTP APIs, so neither CLI has to run — on our machine
that took two 650 MB bridge processes out of the picture. Credentials are read
from the stores those CLIs already keep and are never copied into config;
`models.json` holds only a reader command. Selection is by price, so paid models
are never offered.

```bash
bb pi-gateways status
bb pi-gateways refresh
```

Design notes, including the two traps it exists to avoid, are in
[plugins/bb-plugin-pi-gateways/README.md](plugins/bb-plugin-pi-gateways/README.md).

### `speak` 🔊

A speech button under every chat message that reads it aloud using **Gemini TTS**
(`gemini-3.1-flash-tts-preview`) with one of thirty prebuilt voices — Kore by
default. The Markdown is stripped to prose first, so code blocks are skipped,
links read as their label, and table pipes and emoji are dropped.

The browser's own voice takes over whenever Gemini will not answer: no key, a
rejected key, a spent rate limit, an unreachable endpoint. Every hand-off is
announced, because it decides whether the text leaves the machine.

Each model has its own daily free-tier allowance, so a second model can be named
to move to when the first runs dry — and pointed at a CLIProxyAPI, the reading
spreads across a pool of keys instead of leaning on one.

A floating player gives Play/Pause and speed (`0.75×`–`2.0×`, pitch preserved).
Long messages are cut into chunks and fetched ahead, so the reading starts
before the whole message has been synthesised.

```bash
bb speak status
```

Details in [plugins/bb-plugin-speak/README.md](plugins/bb-plugin-speak/README.md).

### `live-call` 📞 — live voice calls (beta)

A live voice call with the bb coordinator over the Gemini Live API: talk, interrupt,
and let it read threads, message agents, and start them — the last only after you
say «запускай». The call is relayed by the bb server, so Google sees the bb host,
never your device. One `gemini-3.8-live` session with tools (Extended is off, ADR-0006
rev. 2). Three kinds of call: to the coordinator, about a thread, and about a project
with its MCP connectors from an owner-approved registry. Every write is confirmed by a
server-side gate (voice «да» / buttons); confirmation rules and accepted residual risks
are in ADR-0012.

```bash
bb call status
bb call connectors --project <id>   # start a project's MCP connectors without a call and list their tools
```

Two Gemini API keys go into the plugin's secret setting at install; nothing else is needed.

[Spec](docs/specs/live-call.md),
[contract](docs/specs/live-call-contract.md),
ADRs [0005](docs/adr/0005-live-call-server-relay.md)–[0012](docs/adr/0012-live-call-voice-confirmation-rules.md),
[plugin README](plugins/bb-plugin-live-call/README.md).

### `voice-stt` 🎙️ — Gemini STT Live Voice (voice input)

Voice input for bb in two modes:

- **Native mic** in the composer. bb hands the recording to the plugin's
  `ai.voice.transcribe` service: Gemini Live, then Codex, then Groq as fallbacks.
- **Live dictation**: a floating mic button you can drag anywhere. Tap to start and
  tap again to stop, hold to talk, or drag to move it. Speech streams to Gemini Live
  while you talk, and the text lands in the composer draft 1–2 s after you stop.
  Tapping the recording card also stops it. `Ctrl/Cmd+Shift+V` toggles dictation and
  Esc cancels. Nothing is ever sent automatically.
- **Microphone**: Auto picks a sensible input. On a Mac it skips the Continuity
  iPhone mic and virtual devices. You can also pick a device per device under the
  plugin's settings, with a level check. The mic stays warm for 30 s after a
  dictation (`micWarmSeconds`), so the next one starts instantly and includes
  ~0.5 s before the tap. If iOS Web Audio goes silent, capture switches to
  `MediaRecorder`. The audio is decoded on the fly and streamed to the same Gemini
  Live session, so live text keeps coming (verified in Chromium emulation; not yet
  on a real iPhone). If on-the-fly decoding fails, the whole file is transcribed when you stop.

```bash
bb voice-stt status
bb voice-stt transcribe <file>
```

Gemini keys go into the plugin's secret setting. Codex uses the host's Codex login,
and a Groq key is optional.

[Spec (file pipeline)](docs/specs/voice-stt.md),
[spec (live dictation)](docs/specs/voice-stt-live.md),
ADRs [0014](docs/adr/0014-voice-stt-live-floating-button.md),
[0016](docs/adr/0016-voice-stt-mic-capture.md).

### `privacy-blur`

One click blurs sensitive data across the bb interface for screenshots and
screen sharing: emails, bb ids, paths, URLs, domains, IPs, tokens, project
and host names, and your own words. Toggle with the eye button in the
sidebar footer or `Alt+Shift+P`. Text is masked with the CSS Custom
Highlight API, so bb's DOM is never rewritten.

Details in
[plugins/bb-plugin-privacy-blur/README.md](plugins/bb-plugin-privacy-blur/README.md).

### `compact-ui`

The sidebar keeps the first five chats of every project and folds the rest
behind **Ещё N**. Expanding reaches the next decade, then adds ten roots
at a time; **Меньше** removes one batch. Both buttons share a row with the
visible/total root count. Pinned chats, the chat you are in, and
anything waiting on you are never folded away, so the limit only ever hides
chats you are done with.

It replaces bb's thread list through the exclusive
`experimental_threadList` slot, so it also rebuilds what a row does: open,
open in split, pin, read/unread, inline rename, archive, delete, the status
indicator and bb's keyboard-shortcut DOM contract. What it does not rebuild —
list virtualization, project sections, pull-request badges — is listed in the
plugin README, along with the Settings switch that brings bb's own list back.

The plugin also carries bb's screen-space fixes: it caps the whole message
composer (text + attachments + toolbar) at one third of the working area on
desktop and mobile, with overflow absorbed by the editor's own scroll —
[spec](docs/specs/composer-viewport-cap.md),
[ADR 0019](docs/adr/0019-composer-viewport-cap.md).

```bash
bb plugin config compact-ui set visibleThreads 10
```

Details in
[plugins/bb-plugin-compact-ui/README.md](plugins/bb-plugin-compact-ui/README.md).

### `thread-timestamps`

Always-visible date and time above every user and assistant message, in the
browser's local time zone: `13.10.2026 20:11`. Covers new messages, history,
and split panes without opening a menu or hovering over action buttons.

An independently maintained fork of bighitbiker3's Message Timestamps, with
bounded history requests, caching and cleanup on disable.

Details in
[plugins/bb-plugin-thread-timestamps/README.md](plugins/bb-plugin-thread-timestamps/README.md).

### `tasks-pro`

A read-only power view over bb's builtin task tracker, in its own sidebar
panel: a sortable table and a status kanban fed by the same data. Twelve
composable filters (projects, folders, statuses, priorities, labels, due /
created / updated / completed ranges, threads, attachments, depth),
multi-column sorting, grouping, token search across title/key/description/
project/labels, and saved views. Completion dates and status-change
timestamps are enriched from a read-only SQLite read; comments and
attachments come from the tasks plugin's own RPC.

It never mutates tasks — no mutation RPC calls, SQLite opened read-only,
no kanban drag. Details in
[plugins/bb-plugin-tasks-pro/README.md](plugins/bb-plugin-tasks-pro/README.md).

### `orchestrator`

Policy-driven delegation of `bb tasks` to executor threads: one `delegate`
call dispatches the task under a routing policy, wires the executor as a
hidden child with parent notifications, and a watchdog tracks the first
response, quota holds and auto-reissue down the level's route chain. Thread
roles (`orchestrator`, `executor`, `auditor`) decide which instructions and
plugin tools each thread gets.

Details in
[plugins/bb-plugin-orchestrator/README.md](plugins/bb-plugin-orchestrator/README.md).

## Themes

### `arctic-ledger`

A high-contrast blue light theme with a matching dark appearance.

```bash
cp -r themes/arctic-ledger "$(bb theme dir)/"
bb theme set arctic-ledger
```

## Layout

```
.bb/plugins.json   manifest bb reads when installing from a git URL
plugins/           one directory per plugin, each with its own README
themes/            one directory per theme
```

### `server-switcher` — Compact server selector

A monochrome footer icon opens the current server and all switch targets in one click. Closed by default; no avatar rings or nested dropdown. Offline servers are disabled. MIT-licensed maintained fork.

```bash
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin server-switcher --yes
```

Details and upstream attribution: [Server Switcher](plugins/bb-plugin-server-switcher/README.md).
