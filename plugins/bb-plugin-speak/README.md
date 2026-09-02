# `speak` 🔊 — read a message out loud with Gemini TTS

Adds a speech action under every chat message. Press it and bb reads the message
aloud using **Gemini TTS** (`gemini-3.1-flash-tts-preview`) with natural high-definition voices
(Kore, Aoede, Fenrir, Puck, Charon, etc.), or with the browser's own voice when offline.

A modern floating player overlay appears during generation and playback, giving you full control
over playback speed, pause/resume, and chunk progress.

## Features

- **Gemini HD Voices**: High-quality expressive speech synthesis (default: `Kore`).
- **Floating Overlay Player**: Floating card showing generation status, play/pause controls, voice badge, chunk progress, and a speed toggle (`0.75×`, `1×`, `1.25×`, `1.5×`, `2×`).
- **Instant Parallel Synthesis**: When you click play, all chunks are generated concurrently in parallel (T=0) — audio starts in ~1.2s and plays completely gapless.
- **Natural Pitch Preservation**: Built-in WSOLA time-stretching keeps the natural adult voice timbre on any speed without the high-pitched chipmunk effect.
- **Speed Persistence**: Chosen playback speed persists across chunks and stays saved in `localStorage`.
- **Smart Prose Filter**: Strips markdown, code blocks, URLs, tables, and emoji so only readable prose is spoken.
- **Mobile Touch Ready**: Auto-unlocks mobile browser audio on touch.
- **Seamless Fallback**: Gracefully falls back to the browser's local speech synthesis if offline or unconfigured.

## Setup

1. **Configure Gemini API Key / CLIProxy**:
   Go to **Settings → Extensions → Speak** and paste your Gemini API key (or point to your local CLIProxy endpoint).
2. **Pick a Voice**:
   Choose your favorite voice (`Kore`, `Aoede`, `Fenrir`, `Puck`, `Charon`) in settings.

## When a daily quota runs out

AI Studio meters each TTS model separately on its free tier, so 3.1 running dry
says nothing about 2.5. Settings has two pickers for this: **Model**, and
**When spent** — the one to move to. Leave *When spent* empty and the reading
stops at the browser's own voice instead.

The switch is deliberately narrow. Only a spent quota changes model: a rejected
key or an unreachable endpoint fails identically on the second model, and
retrying would just double the wait before the browser voice takes over.

Google answers both a spent *daily* allowance and a tripped *per-minute* limit
with the same HTTP 429, and they deserve very different treatment — the player
fetches several chunks at once, which is exactly what trips the minute. So the
metric named in the error body decides:

| What Google says ran out | How long that model is skipped |
| --- | --- |
| a violation naming the day | until the next midnight, Pacific — where Google rolls daily quotas over |
| a per-minute limit | the `retryDelay` it asked for, or ninety seconds |
| a 429 naming neither | ninety seconds — the cheaper of the two wrong guesses |

A per-minute cooldown never outlives the day it sits inside. And if every model
is benched the chain is tried anyway rather than refusing: the cooldown is this
plugin's guess about a clock it does not own.

Behind a CLIProxyAPI this reads on the pool rather than on one account. Its
`max-retry-credentials: 0` — "try all available credentials" in its own
documentation — means a quota error reaching the plugin is every account in the
pool being out for that model, not one unlucky key.

`bb speak status` prints both models and, when one is benched, the time it
comes back.

## Layout

| Path | What lives there |
| --- | --- |
| `src/contract.ts` | The RPC contract and default configuration |
| `src/speakable.ts` | Markdown → clean prose filter and language detection |
| `src/chunk.ts` | Smart sentence-boundary chunking |
| `src/gemini-tts.ts` | Gemini TTS client and 24kHz PCM-to-WAV converter |
| `src/player.ts` | Parallel streaming player, pitch-preserving audio pipeline, speed control |
| `src/SpeakOverlay.ts` | Vanilla DOM floating player overlay |
| `server.ts` | Server RPC endpoints (`synthesize`, `probe`, `status`, `savePrefs`) and the cancellable `POST http/synthesize` route |

| `src/SpeakSection.tsx` | the settings section |
| `app.tsx` | the two slot registrations |
| `lib/rpc.ts` | fetch wrapper — `useRpc` is a hook and `run()` is not a component |

## Why synthesis has two doors

`bb.rpc` hands a handler its validated input and nothing else — no request, no
signal — so it cannot tell a listening caller from one that hung up. Stop
therefore used to reach only the browser: up to five chunks kept generating on
Google's side, and spending quota, after the audio went quiet.

`bb.http` hands the handler the whole request, whose signal the server aborts
when the client connection closes. The player posts its chunks there
(`/api/v1/plugins/speak/http/synthesize`, same envelope, same local-origin
auth) and passes that signal down to `fetch`. A cancellation is deliberately
not a failure: no warning is logged, no second model is tried, and no model is
benched — the route just answers 499 to a client that is already gone.

## Verification

```bash
cd plugins/bb-plugin-speak
npm install
npx tsc --noEmit
node --experimental-strip-types --test tests/*.test.ts
```

`bb speak status` reports whether a key is configured, both models and any
quota cooldown on them, and the rest of the current preferences — never the key
itself.

The model is a preference rather than a plugin setting, so it is not reachable
through `bb plugin config` (which owns only `geminiApiKey` and `baseUrl`).
Change it in the settings section, or post a complete preferences object —
`prefsSchema` validates all five fields together and rejects a partial one:

```bash
curl -X POST http://127.0.0.1:<bb-port>/api/v1/plugins/speak/rpc/savePrefs \
  -H 'content-type: application/json' \
  -d '{"prefs":{"voice":"Kore","model":"gemini-2.5-flash-preview-tts",
       "fallbackModel":"gemini-3.1-flash-tts-preview","browserRate":1,
       "fallbackEnabled":true}}'
```
