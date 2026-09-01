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

## Layout

| Path | What lives there |
| --- | --- |
| `src/contract.ts` | The RPC contract and default configuration |
| `src/speakable.ts` | Markdown → clean prose filter and language detection |
| `src/chunk.ts` | Smart sentence-boundary chunking |
| `src/gemini-tts.ts` | Gemini TTS client and 24kHz PCM-to-WAV converter |
| `src/player.ts` | Parallel streaming player, pitch-preserving audio pipeline, speed control |
| `src/SpeakOverlay.ts` | Vanilla DOM floating player overlay |
| `server.ts` | Server RPC endpoints (`synthesize`, `probe`, `status`, `savePrefs`) |

| `src/SpeakSection.tsx` | the settings section |
| `app.tsx` | the two slot registrations |
| `lib/rpc.ts` | fetch wrapper — `useRpc` is a hook and `run()` is not a component |

## Verification

```bash
cd plugins/bb-plugin-speak
npm install
npx tsc --noEmit
node --experimental-strip-types --test tests/*.test.ts
```

`bb speak status` reports whether a key is configured and what the current
preferences are, without printing the key.
