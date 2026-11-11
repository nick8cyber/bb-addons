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
2. Size gate on `usedTokens`: up to ~800k → a single request. Larger histories
   go through hierarchical chunking: `bb handoff export --up-to-seq <N>` prefix
   slices at agent-message boundaries → per-chunk summaries → merged summary
   (extra reduce rounds if the merge itself overflows). What still doesn't fit
   is refused explicitly (`too_large`), never silently truncated.
3. REST `generateContent` call on `gemini-3.6-flash`; on 429/403/5xx the next
   key is tried, on 400/404 the request is not retried.
4. A new thread spawns in the same project and environment; its first message is
   the summary plus a link to the source thread.

Keys only ever travel in the `x-goog-api-key` request header — never in logs,
errors, or RPC output.

## UI

- **Thread action** «Compact via external provider» in the thread menu (lifecycle
  group) and the same command in the composer palette. Both open a confirmation
  dialog warning that the history will be sent to the external summarizer — no action
  without the owner's explicit «Продолжить».
- **Cache badge** «⏳ compact?» on the thread row when the thread's prompt cache
  has expired (`usage.compactionOfferAt` in the past). Polls `threads.context`
  at most once per 60s and only for idle/error threads.
- Progress and result surface as toasts; the success toast has an «Открыть»
  button navigating to the continuation thread.

## Checks

```bash
npx tsc --noEmit
npx vitest run
```
