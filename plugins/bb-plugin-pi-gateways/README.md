# bb-plugin-pi-gateways

Use **Google AI Studio**, **TokenRouter**, **OpenRouter**, **NVIDIA Build**, free models from **OpenCode Zen**
and the **Kilo Code gateway**, plus custom endpoints inside bb through pi.
OpenCode and Kilo are reached over HTTP by token, so neither CLI has to run.

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
- Fetches each catalogue through its native protocol and offers **only
  zero-priced models** under the existing OpenCode/Kilo/custom semantics. A
  missing pricing block counts as free there because gateways like OpenCode
  Zen list only what the credential may use. Google is deliberately stricter:
  its catalogue has no prices, so no Google model is classified as free and
  every saved Google model must be selected explicitly.
  OpenRouter publishes catalogue prices, so only models with an explicit zero
  price are selected automatically; an unpriced OpenRouter model is not free.
  NVIDIA Build does not guarantee catalogue pricing; its
  preset requires explicit model selection and never classifies an unpriced
  model as free.
- Merges: it replaces only provider ids it owns and leaves every other entry in
  `models.json` untouched, keeping a timestamped copy
  (`models.json.bak-pi-gateways-YYYYMMDD-HHMMSSmmm`, ten retained) of the exact
  bytes it replaced before each write. Writes are serialised in the host worker
  and re-checked by content hash, so a concurrent write from another tool is
  detected and the change is re-applied to the fresh file instead of
  overwriting it.
- Manages **every** provider in `models.json`, not only the ones it created:
  foreign blocks are listed read-only and can be adopted, edited, refreshed or
  force-deleted. See "Ownership and adoption" below.

## Ready-to-use presets and custom endpoints

The settings UI presents clear **Google AI Studio**, **TokenRouter**, **OpenRouter**,
**NVIDIA Build**, and **Custom** choices. A preset fills the display name, service
URL, connection type, and environment-variable hint. The internal provider key
is always allocated automatically; users never enter it. The host checks pi's
reserved ids and every existing `models.json` provider before Save.

List and use the same shared preset catalogue from the CLI:

```bash
bb pi-gateways presets

# GEMINI_API_KEY is the default key reference for this preset.
bb pi-gateways test --preset google-ai-studio
bb pi-gateways add --preset google-ai-studio --models <id-from-test>

# TOKENROUTER_API_KEY is the default key reference here.
bb pi-gateways test --preset tokenrouter
bb pi-gateways add --preset tokenrouter

# OPENROUTER_API_KEY is the default key reference; catalogue prices enable
# automatic free-model selection.
bb pi-gateways test --preset openrouter
bb pi-gateways add --preset openrouter

# NVIDIA_API_KEY is the default key reference; prices are unknown so explicit
# --models selection is required (no model is assumed free).
bb pi-gateways test --preset nvidia-build
bb pi-gateways add --preset nvidia-build --models <id-from-test>
```

Pass one of `--key-file`, `--key-env`, or `--key-command` to override the
preset's environment-variable hint. The referenced environment variable must
be available to the bb daemon on the target host.

Google discovery uses Google's native model catalogue and inference API. It
authenticates with the `x-goog-api-key` header, follows catalogue pagination,
and keeps only text/chat models that support `generateContent`. Context and
output token limits are carried into pi's model entries.

**Google price safety:** Google does not publish prices in this catalogue.
The plugin never calls those models free, never saves the whole list
implicitly, and requires explicit model selection in the UI or `--models` in
the CLI. Selected models may incur charges.

For another supported endpoint, use Custom in Settings or provide the
connection manually:

Any OpenAI-compatible API root can be added through the settings section
(**Settings → Pi Gateways**) or headlessly:

```bash
bb pi-gateways test \
  --base-url https://example.com/v1 --api openai-completions \
  --key-env EXAMPLE_API_KEY          # or --key-file /path/to/key | --key-command '...'

bb pi-gateways add \
  --name "Example" \
  --base-url https://example.com/v1 --api openai-completions \
  --key-env EXAMPLE_API_KEY          # [--paid] [--models id1,id2] to narrow

bb pi-gateways list                   # every provider in models.json, grouped
bb pi-gateways show example           # one provider in full detail
bb pi-gateways delete example         # removes exactly this id
```

What happens on save:

- The endpoint is probed live first if you click **Test**: catalogue fetch,
  free/paid split by price, and one `max_tokens=1` call against the first free
  model — because a catalogue listing proves nothing about whether inference
  actually answers. Google uses native `:generateContent` and smoke-tests the
  first compatible model because prices are unknown. NVIDIA Build follows the
  same explicit-selection path as Google. OpenRouter uses catalogue pricing
  for automatic free-model selection and excludes unpriced entries from the
  free set.
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
- Saved definitions retain their protocol and explicit model selection, so
  refresh after a bb restart follows the same discovery and safety path as
  the original Save.

## Ownership and adoption

`models.json` is a shared file. This plugin therefore derives a **state** for
every id it sees, rather than assuming it owns anything:

| State | Meaning | What you can do |
|---|---|---|
| `builtin` | OpenCode Zen or Kilo Code | `refresh` / `remove` |
| `owned` | created by this plugin | edit, refresh, delete |
| `adopted` | pre-existing block now managed here | edit, refresh, delete, disown |
| `foreign` | in `models.json`, not managed | adopt, or delete with `--force` |
| `orphaned` | recorded here, missing from the file | refresh to write it again, or disown |
| `reserved` | an id pi ships its own catalogue for | nothing — never adoptable |

Plus a `drifted` flag: the block changed in `models.json` after this plugin last
wrote it. Refreshing or saving a drifted provider would overwrite somebody
else's change, so it is refused until you accept it explicitly
(`--accept-drift`, or a second press in the UI).

```bash
bb pi-gateways adopt gen-openrouter               # key stays exactly where it is
bb pi-gateways adopt gen-openrouter --key-env OPENROUTER_API_KEY
                                                  # …or migrate it to a reference
bb pi-gateways disown gen-openrouter              # forget it; models.json untouched
bb pi-gateways edit gen-openrouter --name "OpenRouter (generated)" --models a,b
bb pi-gateways refresh-endpoints --only gen-openrouter [--accept-drift]
bb pi-gateways delete some-foreign-block --force  # force is required when unmanaged
```

**Adoption never moves a credential.** How a key is treated depends on what the
block already holds, classified with a port of pi's own reference grammar
(`!command`, `$VAR`, `${VAR}`, `$$`/`$!` escapes, mixed templates — a prefix
check is not enough, `$TOKEN-suffix` is a literal, not an env reference):

- `!command` and a single `$VAR` are configuration, not secrets: they are copied
  into the plugin's manifest as-is and shown verbatim.
- Anything with literal text — including `Bearer $TOK` and a pasted `sk-…` — is
  adopted **in place**: the manifest records only "the key lives in
  models.json", the value is re-read from the live file whenever a request needs
  it, and it is carried forward byte-identically on every write. It is never
  copied into the manifest, returned over RPC, logged, or included in an error.
  Redacted display is `«literal, N chars»`.
- `headers` values resolve exactly like keys, so they are assumed to be secrets
  too: only header **names** ever leave the host, and the values are preserved
  verbatim on every write.
- Adopting is otherwise a **zero-write** operation — nothing in `models.json`
  changes — which makes `disown` its exact inverse. The one exception is an
  explicit key migration, which rewrites just that block's `apiKey`.
- Adoption never grants automatic free-model selection: the current model list
  is pinned explicitly, because another gateway's pricing semantics are unknown.
- A block whose `api` this plugin cannot speak is adopted as *limited*: rename,
  hand-edit its model list (`--allow-unverified-models`) and delete work;
  probe and refresh are refused per id.

### Living with an external generator

If a script such as `gen-pi-models.py` keeps rewriting a block you adopted, the
provider will show up as `drifted` after every generator run, and refreshes will
ask you to confirm before overwriting it. Pick one owner per id: either disown
the ids the generator maintains, or stop generating the ones you adopted. The
generator does not read this plugin's manifest, so this is a convention, not a
lock.

## Use

```bash
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin pi-gateways --yes

bb pi-gateways status            # what is detected, what is configured
bb pi-gateways list              # the full inventory with ownership states
bb pi-gateways refresh           # re-read the built-in catalogues and write them
bb pi-gateways refresh-endpoints # re-read the catalogues of managed providers
bb pi-gateways remove            # delete only this plugin's built-in entries
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

This plugin's saved-provider presets use **collision-safe internal id stems**
(`tokenrouter`, `openrouter`, `nvidia-build`). The host compares each stem with
pi's built-in catalogue, existing `models.json` providers, and ids already
owned by the plugin, then adds a numeric suffix when necessary. Users never
enter ids manually.

**Never select free models by name.** `stealth/ox-alpha` costs nothing and
carries no `:free` suffix; filtering on the word "free" silently drops it — 17
models found by name against 20 by price on the Kilo catalogue. Selection here
is by price only, and anything a coding agent cannot drive (audio, video,
embeddings) is excluded by kind.

## Limits

- Google and NVIDIA Build catalogue prices are not guaranteed. An explicit
  selection is a choice of models, not a claim that they are free; consult the
  provider's billing terms.
- Paid models are opt-in only (`--paid` / toggling off in the UI), and a save
  with paid models included re-verifies prices against the fresh catalogue.
- A gateway can answer `429` when its free tier or shared pool is exhausted.
  That is the gateway rate-limiting you, not a broken configuration.
- Kilo serves free models from its own pool (`"is_byok": false`), so no
  OpenRouter key of your own is involved. Its paid models require credits and
  are not touched here.
- Editing a managed provider re-validates its pinned models against a fresh
  catalogue. If the gateway has since delisted one of them, the edit is refused
  until you pass `--allow-unverified-models`; a *refresh* keeps such a model
  instead of failing, and reports it.
- The probe's live call is a wire smoke test from the daemon host. It cannot
  reproduce every adapter nuance of pi itself, and environment differences
  between hosts mean "works here" proves the endpoint, not every machine.
