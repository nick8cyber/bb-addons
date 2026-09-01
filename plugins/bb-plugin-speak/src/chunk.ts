/**
 * Cutting a message into pieces small enough to be worth waiting for.
 *
 * Gemini imposes no input limit of its own; what constrains a chunk is that
 * the audio comes back uncompressed — about 3.5 KB of PCM per character — so
 * the budget is measured in characters of *input*, not bytes on the wire.
 *
 * This is the contract's shared source of truth for chunk boundaries: the
 * client sends an index and the server re-derives the same split from the same
 * text. So this function must be **deterministic and pure** — the same input
 * has to give the same output on every call, in either process, forever. No
 * clock, no randomness, no configuration read from anywhere but the arguments.
 */
import { CHUNK_CHARS, FIRST_CHUNK_CHARS } from "./contract.js";

/** A blank line: the cleanest place to stop, because the pause is intended. */
const PARAGRAPH = /\n[^\S\n]*\n/g;
/**
 * A full stop, question mark, exclamation mark or ellipsis, together with any
 * closing quote or bracket trailing it. Russian punctuation puts the quote
 * after the stop (`…сказал он.»`), so cutting between them would open the next
 * chunk with a stray `»`.
 */
const SENTENCE = /[.!?…]+[)\]}"'»”’]*(?=\s|$)/gu;
const LINE = /\n/g;
const WORD = /\s+/g;

/**
 * A split point is only worth taking if it fills at least half the budget.
 * Without this, one early sentence end ("Да. …") would emit a three-character
 * chunk and buy a whole round trip for it.
 */
const MIN_FILL = 0.5;

/**
 * `budget` characters of `text`, pulled back by one if that would land between
 * the halves of a surrogate pair. Counting in UTF-16 units is what `.length`
 * does everywhere else here; this is the one place the difference can bite.
 */
function safeLimit(text: string, budget: number): number {
  const limit = Math.min(text.length, budget);
  if (limit <= 1 || limit >= text.length) return limit;
  const code = text.charCodeAt(limit - 1);
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return isHighSurrogate ? limit - 1 : limit;
}

/** The last position at or before `limit` where `pattern` ends, or -1. */
function lastCutWithin(window: string, pattern: RegExp, limit: number): number {
  pattern.lastIndex = 0;
  let cut = -1;
  for (let match = pattern.exec(window); match !== null; match = pattern.exec(window)) {
    if (match[0].length === 0) {
      pattern.lastIndex = match.index + 1;
      continue;
    }
    const end = match.index + match[0].length;
    if (end > 0 && end <= limit) cut = end;
  }
  return cut;
}

function chooseCut(text: string, limit: number): number {
  // One character past the limit so that `(?=\s|$)` sees the real next
  // character instead of a truncation that only looks like an end of sentence.
  const window = text.slice(0, Math.min(text.length, limit + 1));
  const candidates = [PARAGRAPH, SENTENCE, LINE, WORD].map((pattern) =>
    lastCutWithin(window, pattern, limit),
  );
  const minFill = Math.max(1, Math.floor(limit * MIN_FILL));
  for (const cut of candidates) if (cut >= minFill) return cut;
  // Nothing fills the budget: take the furthest boundary there is, and if the
  // budget lands inside one very long word, cut the word rather than loop.
  const furthest = Math.max(...candidates);
  return furthest > 0 ? furthest : limit;
}

/**
 * Split text into pieces of at most `limits.first` then `limits.rest`
 * characters.
 *
 * The first chunk is deliberately smaller: it is the one the user waits for in
 * silence before hearing anything, while every later chunk only has to keep
 * ahead of playback. Empty or whitespace-only input gives `[]`; no chunk is
 * ever empty; a single word longer than the budget is emitted in pieces rather
 * than looping forever on a cut it cannot make.
 */
export function chunkForSynthesis(
  text: string,
  limits?: { first?: number; rest?: number },
): string[] {
  const first = Math.max(1, Math.floor(limits?.first ?? FIRST_CHUNK_CHARS));
  const rest = Math.max(1, Math.floor(limits?.rest ?? CHUNK_CHARS));

  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    const budget = chunks.length === 0 ? first : rest;
    if (remaining.length <= budget) {
      chunks.push(remaining);
      break;
    }
    // `chooseCut` never returns 0, so every pass consumes at least one
    // character and the loop cannot stall on an unsplittable word.
    const cut = chooseCut(remaining, safeLimit(remaining, budget));
    const head = remaining.slice(0, cut).trim();
    if (head.length > 0) chunks.push(head);
    remaining = remaining.slice(cut).trim();
  }
  return chunks;
}
