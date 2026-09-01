# `speak` — read a message out loud

Adds one button to the action bar under every chat message. Press it and bb
reads the message to you: the Markdown is stripped down to something a speech
engine can pronounce, sent to Google Cloud Text-to-Speech, and played back.
Press it again to stop.

Without a Google key it still works — the browser's own voice takes over. That
voice is free and offline and sounds like it.

## Setup

The button works the moment the plugin is enabled. The Google half is optional
and takes one field.

1. **Get a key.** In a Google Cloud project, enable the **Cloud Text-to-Speech
   API**, then create an API key under *APIs & Services → Credentials*. Restrict
   it to that one API while you are there; nothing here needs a broader key.

2. **Paste it into Settings → Extensions → Speak.** The field is the
   host-rendered *Google Cloud API key*. It is a `secret` plugin setting, which
   means bb writes it to a 0600 file under its data directory and never puts it
   in the database or in any payload sent to a browser. That is also why the
   browser asks the bb server to synthesize instead of calling Google itself.

3. **Pick a voice.** The section below the key lists what Google actually offers
   for Russian and English, so a voice that has been retired cannot be selected.
   That list arrives with the key — before then the rows say so. Leave it on
   *Let Google choose* if you do not care.

Google's free tier covers a monthly character allowance and bills past it, with
WaveNet and Neural2 voices costing several times what the standard ones do.
Worth knowing before you leave it on a long thread.

## What it does to the text

A message is Markdown, and Markdown read aloud is unbearable — asterisks
pronounced, URLs spelled out, table pipes. `src/speakable.ts` strips it to prose
first:

| In the message | Read as |
| --- | --- |
| Fenced or indented code block | nothing — skipped entirely |
| `` `identifier` `` | `identifier`, backticks gone |
| `[the docs](https://…)` | *the docs* |
| a bare `https://…` | nothing |
| `## Heading` | *Heading.* — the full stop buys a pause |
| `- item` | *item.* |
| a table row | nothing |
| `**bold**`, `_italic_` | the word alone; `some_var_name` survives |
| an emoji | nothing |

A message that is only a code block therefore has nothing to say, and the button
tells you so rather than playing silence.

The language is guessed from the script — Cyrillic against Latin — and decides
which voice speaks. Long messages are cut into pieces under Google's 5000-**byte**
input limit at sentence boundaries and played back to back; the limit counts
bytes, and Cyrillic spends two per letter, which is why the budget looks
conservative.

## Where the text goes

With a key configured, the message text leaves your machine: bb's server posts
it to `texttospeech.googleapis.com`. With no key, or when Google refuses, the
browser speaks it locally and nothing is sent anywhere.

Every hand-off from the first to the second is announced, because which one
spoke is the difference between the text leaving the machine and not. Running
with no key at all is announced once a session rather than on every click —
that is a steady state you chose, not an event, and a red toast under every
message would be nagging you about the configuration you meant.

The key itself is never logged, never returned to the frontend, and is redacted
out of any Google error text this plugin quotes back at you.

## The button

bb's icon set has no speaker glyph — the full list is `ICON_NAMES` in the app
bundle — so the action uses `Play`. Unknown icon names degrade silently to a
generic square, which would be worse.

The action bar is the same one on user and assistant messages, and the SDK has
no predicate for restricting a `messageAction` to one role, so the button
appears on your own messages too. Harmless, and better than the alternative of
not having it where you want it.

Selecting text inside an assistant message and invoking the action from the
selection menu reads only the selection.

## Layout

| Path | What lives there |
| --- | --- |
| `src/contract.ts` | the RPC contract both halves compile against |
| `src/speakable.ts` | Markdown → speakable prose, and language detection |
| `src/chunk.ts` | splitting under Google's byte limit |
| `src/google-tts.ts` | the Text-to-Speech client; the only file that sees the key |
| `server.ts` | settings, preferences, and the four RPC methods |
| `src/player.ts` | playback, the toggle, and the browser fallback |
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
