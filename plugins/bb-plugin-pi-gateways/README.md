# bb-plugin-pi-gateways

Free models from **OpenCode Zen** and the **Kilo Code gateway** inside bb,
reached over their HTTP APIs by token — so neither CLI has to run.

## Why

bb has no agent loop of its own: every provider is a bridge to something that
does. `acp-opencode` and `acp-kilo` therefore keep a full Node process alive per
open thread — around 650 MB each on our machine, 1.3 GB for two threads, most of
it just to act as a transport to models.

`pi` is the exception. It is bundled into the bb daemon, so it costs no extra
process, and it reads its provider catalogue from `~/.pi/agent/models.json`.
Point it at those same gateways over plain HTTP and you keep the free models
while the heavyweight bridges stay unstarted.

This plugin does the pointing.

## What it does

- Finds the credentials the two CLIs already keep — `auth.json` for OpenCode,
  the `credential` table of `kilo.db` for Kilo — and never copies them.
- Installs two tiny reader scripts and writes only
  `"apiKey": "!node <reader>"` into `models.json`. pi runs the reader when a
  session starts, so a rotated token needs no config change and the file stays
  safe to commit.
- Fetches each catalogue and offers **only zero-priced models**, then writes
  them in.
- Merges: it replaces the two provider ids it owns and leaves every other entry
  in `models.json` untouched, keeping a `.bak-pi-gateways` copy of the previous
  file.

## Use

```bash
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin pi-gateways --yes

bb pi-gateways status    # what is detected, what is configured
bb pi-gateways refresh   # re-read the catalogues and write the entries
bb pi-gateways remove    # delete only this plugin's entries
```

Add `--host <id|name>` when several machines are enrolled — `models.json` is
per-machine. `refresh --only kilo` limits the run to one gateway.

**Restart bb after a refresh.** pi keeps its provider catalogue in memory, so
new models do not appear in the picker until the server reloads:

```bash
systemctl --user restart bb.service
```

## Two traps this plugin exists to avoid

**Never name a provider after one pi already knows.** pi ships its own
catalogue for `opencode`, `opencode-go`, `openrouter`, `nvidia` and about thirty
more. Reuse one of those ids and pi merges its whole built-in list in as soon as
it sees a credential — we watched `openrouter` grow from 17 entries to 358,
nearly all of them paid. Hence `opencode-zen`, which pi does not know.

**Never select free models by name.** `stealth/ox-alpha` costs nothing and
carries no `:free` suffix; filtering on the word "free" silently drops it — 17
models found by name against 20 by price on the Kilo catalogue. Selection here
is by price only, and anything a coding agent cannot drive (audio, video,
embeddings) is excluded by kind.

## Limits

- Paid models are never offered. There is no opt-in, on purpose: a mistake in
  that filter spends real money.
- A gateway can answer `429` when its free tier or shared pool is exhausted.
  That is the gateway rate-limiting you, not a broken configuration.
- Kilo serves free models from its own pool (`"is_byok": false`), so no
  OpenRouter key of your own is involved. Its paid models require credits and
  are not touched here.
