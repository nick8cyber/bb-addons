# bb-addons

Plugins and themes for [bb](https://getbb.app). Five plugins, one theme, all
usable independently.

Install any of them straight from this repository:

```bash
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin ru
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin favorite-models
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin provider-agy
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin pi-gateways
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin speak
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

The README also documents a real trap worth reading before writing any provider
bridge: how a refused `write_to_file` argument silently costs you a whole run —
[plugins/bb-plugin-provider-agy/README.md](plugins/bb-plugin-provider-agy/README.md).

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
