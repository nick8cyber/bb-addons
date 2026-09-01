/**
 * Cutting a message into pieces Google will accept.
 *
 * The endpoint's limit is on UTF-8 bytes, not characters, and Cyrillic spends
 * two bytes a letter — measuring with `.length` would wave a Russian message
 * through at twice its real size. Everything here counts encoded bytes.
 */
import { MAX_CHUNK_BYTES } from "./contract.js";

const encoder = new TextEncoder();

const byteLength = (text: string): number => encoder.encode(text).length;

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
 * Without this, one early sentence end ("Да. …") would emit a three-byte chunk
 * and Google would be paid a request for it.
 */
const MIN_FILL = 0.5;

/** How many characters of `text` fit in `maxBytes`, never splitting a code point. */
function prefixLimit(text: string, maxBytes: number): number {
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (bytes + size > maxBytes && index > 0) break;
    bytes += size;
    index += char.length;
    // A single code point larger than the whole budget still has to go out.
    if (bytes >= maxBytes) break;
  }
  return index;
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

/** Split text into pieces no larger than maxBytes UTF-8 bytes. */
export function chunkForSynthesis(text: string, maxBytes: number = MAX_CHUNK_BYTES): string[] {
  const budget = Math.max(1, Math.floor(maxBytes));
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    if (byteLength(rest) <= budget) {
      chunks.push(rest);
      break;
    }
    const cut = chooseCut(rest, prefixLimit(rest, budget));
    const head = rest.slice(0, cut).trim();
    if (head.length > 0) chunks.push(head);
    rest = rest.slice(cut).trim();
  }
  return chunks;
}
