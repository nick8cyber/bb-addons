# bb-plugin-pi-gateways

Free models from **OpenCode Zen** and the **Kilo Code gateway** — plus **any
OpenAI-compatible endpoint you add yourself**, inside bb through pi, reached
over HTTP by token — so neither CLI has to run.

## Why

bb has no agent loop of its own: every provider is a bridge to something that
does. `acp-opencode` and `acp-kilo` therefore keep a full Node process alive per
open thread — around 650 MB each on our machine, 1.3 GB for two threads, most of
it just to act as a transport to models.

`pi` is the exception. It is bundled into the bb daemon, so it costs no extra
process, and it reads its provider catalogue from `~/.pi/agent/models.json`.
Point it at those same gateways over plain HTTP and you keep the free models
while the heavyweight bridges stay unstarted.

This plugin does the pointing — from the command line and from a settings UI.

## What it does

- Finds the credentials the two CLIs already keep — `auth.json` for OpenCode,
  the `credential` table of `kilo.db` for Kilo — and never copies them.
- Installs tiny reader scripts and writes only
  `"apiKey": "!<reader>"` (or `$VAR`, or any `!command`) into `models.json`.
  pi runs that reference when a session starts, so a rotated token needs no
  config change and the file stays safe to commit.
- Fetches each catalogue and offers **only zero-priced models**, then writes
  them in. A missing pricing block counts as free: gateways like OpenCode Zen
  list only what the credential may use. Such models are marked
  “price not listed” in the UI so nobody mistakes a guess for a promise.
- Merges: it replaces only provider ids it owns and leaves every other entry in
  `models.json` untouched, keeping a `.bak-pi-gateways` copy before each write.
  Ownership is recorded per id; blocks owned by other writers (for example the
  `tools/gen-pi-models.py` generator behind `cliproxy`, `tokenrouter`,
  `nvidia`) are refused on both save and delete.

## Custom endpoints

Any OpenAI-compatible API root can be added through the settings section
(**Settings → Pi Gateways**) or headlessly:

```bash
bb pi-gateways test \
  --base-url https://example.com/v1 --api openai-completions \
  --key-env EXAMPLE_API_KEY          # or --key-file /path/to/key | --key-command '...'

bb pi-gateways add \
  --id example --name "Example" \
  --base-url https://example.com/v1 --api openai-completions \
  --key-env EXAMPLE_API_KEY          # [--paid] [--models id1,id2] to narrow

bb pi-gateways list                   # built-ins plus custom endpoints
bb pi-gateways delete example         # removes exactly this id
```

What happens on save:

- The endpoint is probed live first if you click **Test**: catalogue fetch,
  free/paid split by price, and one `max_tokens=1` call against the first free
  model — because a catalogue listing proves nothing about whether inference
  actually answers.
- The credential source must be an environment variable (`$VAR`), a file (a
  reader script is generated and the path passed as argv — no shell quoting
  traps), or a shell command (`!command`). Literal keys are rejected by
  construction: a pasted secret must never be able to reach models.json.
- The provider id may not collide with anything pi ships (its bundled catalogue
  ids are discovered at runtime from the pi installation) nor with ids owned by
  other writers. If pi's catalogue cannot be located, saving is refused rather
  than guessed through.
- Definitions persist in the plugin's host data directory keyed by id, holding
  only references — never key values — so endpoints survive and can be
  refreshed even while models.json is being edited elsewhere.

## Use

```bash
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin pi-gateways --yes

bb pi-gateways status    # what is detected, what is configured
bb pi-gateways refresh   # re-read the catalogues and write the entries
bb pi-gateways remove    # delete only this plugin's built-in entries
```

Add `--host <id|name>` when several machines are enrolled — `models.json` is
per-machine, and the settings UI carries the same picker.

Existing pi bridge workers keep the provider catalogue they loaded at startup.
A newly started worker reads the updated `models.json`. If the picker must
refresh immediately, restart bb only when no pi turn is running:

```bash
systemctl --user restart bb.service
```

The plugin deliberately does not terminate pi bridge workers itself: doing so
would also terminate any active pi-backed agent turn.

## Two traps this plugin exists to avoid

**Never name a provider after one pi already knows.** pi ships its own
catalogue for `opencode`, `opencode-go`, `openrouter`, `nvidia`, `radius` and
about thirty more. Reuse one of those ids and pi merges its whole built-in list
in as soon as it sees a credential — we watched `openrouter` grow from 17
entries to 358, nearly all of them paid. Hence `opencode-zen`, which pi does
not know, and the runtime reserved-id check with fail-closed discovery.

**Never select free models by name.** `stealth/ox-alpha` costs nothing and
carries no `:free` suffix; filtering on the word "free" silently drops it — 17
models found by name against 20 by price on the Kilo catalogue. Selection here
is by price only, and anything a coding agent cannot drive (audio, video,
embeddings) is excluded by kind.

## Limits

- Paid models are opt-in only (`--paid` / toggling off in the UI), and a save
  with paid models included re-verifies prices against the fresh catalogue.
- A gateway can answer `429` when its free tier or shared pool is exhausted.
  That is the gateway rate-limiting you, not a broken configuration.
- Kilo serves free models from its own pool (`"is_byok": false`), so no
  OpenRouter key of your own is involved. Its paid models require credits and
  are not touched here.
- The probe's live call is a wire smoke test from the daemon host. It cannot
  reproduce every adapter nuance of pi itself, and environment differences
  between hosts mean "works here" proves the endpoint, not every machine.
