# External Compact

Compress a cooled-off bb thread **outside** the provider session: the serialized
history is summarized by a free `gemini-3.6-flash` via AI Studio, and the
conversation continues in a new thread — the expensive model never re-reads the
old context. Spec: [docs/specs/external-compact.md](../../docs/specs/external-compact.md).

```bash
bb external-compact <thread-id>   # compact a thread, continue in a new one
bb external-compact status        # key configured? readiness?
```

## Settings

| Setting | What |
|---|---|
| `geminiApiKey` (secret) | 1–2 AI Studio keys, one per line — the second is a 429 fallback |
| `autoArchiveSource` | Archive the source thread after a successful compact (default off; the source is never deleted) |

## How it works

1. `bb handoff export <thread-id>` writes the serialized history.
2. Size gate: up to ~800k used tokens → a single request; larger histories are
   refused explicitly until chunked summarization lands.
3. One REST `generateContent` call on `gemini-3.6-flash`; on 429/403/5xx the
   next key is tried.
4. A new thread spawns in the same project and environment; its first message is
   the summary plus a link to the source thread.

Keys only ever travel in the `x-goog-api-key` request header — never in logs,
errors, or RPC output.

## Checks

```bash
npx tsc --noEmit
npx vitest run
```
