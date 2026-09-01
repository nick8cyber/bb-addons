/**
 * Turns Markdown from chat messages into plain text suitable for speech engines.
 *
 * Pipeline ordering rationale:
 * 1. Fenced/indented code blocks stripped first: their contents can contain
 *    arbitrary markdown/HTML syntax that must not trigger downstream rules.
 * 2. HTML comments & script/style blocks stripped before tags: metadata and
 *    executable code must not leak into speakable text.
 * 3. Footnotes stripped before links/emphasis: footnote syntax [^1] could
 *    otherwise be misidentified as reference links or emphasis.
 * 4. Images stripped before links: `![alt](url)` contains link syntax
 *    `[alt](url)`, so stripping images first prevents leaving dangling alt text.
 * 5. Links replaced with labels & bare URLs removed: URLs are unpronounceable
 *    noise when read aloud.
 * 6. Tables stripped before headings/lists: pipe rows and delimiter rows must
 *    not be parsed as Setext underlines or thematic breaks.
 * 7. Setext and ATX headings given terminal punctuation: speech engines need
 *    a clause boundary to pause between headings and following text.
 * 8. Thematic breaks removed: standalone horizontal rules convey no prose.
 * 9. Blockquotes, task boxes, list markers stripped & given terminal punctuation:
 *    list items without periods run together when spoken.
 * 10. Inline code backticks stripped: file names and identifiers must be read.
 * 11. Emphasis stripped with word-boundary awareness: intra-word underscores
 *     in variable names must remain intact.
 * 12. HTML tags stripped, `<br>` converted to breaks, and entities decoded:
 *     entities must resolve to actual characters before speech synthesis.
 * 13. Emoji and pictographs stripped: speech engines pronounce raw emoji names,
 *     which creates severe acoustic noise.
 * 14. Whitespace collapsed and trimmed: normalizes pauses and eliminates blanks.
 * 15. Length truncated at sentence boundary: stays within provider payload limits
 *     without clipping mid-phrase.
 */
import { MAX_SPEAKABLE_CHARS } from "./contract.js";

const TERMINAL_PUNCTUATION_RE = /[.!?…:;][)\x27"»”’\]}]*$/u;

/** Appends a full stop to lines that lack terminal punctuation to enforce pauses. */
function ensureTerminalPunctuation(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (TERMINAL_PUNCTUATION_RE.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}.`;
}

/** Decodes named and numeric HTML entities into their plain character representations. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, dec) => {
      try {
        return String.fromCodePoint(Number.parseInt(dec, 10));
      } catch {
        return _m;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return _m;
      }
    })
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»");
}

/** Removes Markdown table structures entirely, including pipe rows and delimiter rows. */
function stripTables(text: string): string {
  const lines = text.split("\n");
  const isPipeLine = (l: string): boolean => /^[ \t]*\|.*$/.test(l);
  const isDelimiterLine = (l: string): boolean =>
    /^[ \t]*\|?[\s]*:?-{1,}:?[\s]*(?:\|[\s]*:?-{1,}:?[\s]*)+\|?[ \t]*$/.test(l) &&
    l.includes("-");

  const toRemove = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isPipeLine(line)) {
      toRemove.add(i);
    } else if (isDelimiterLine(line)) {
      toRemove.add(i);
      // Header row directly preceding the delimiter
      if (i > 0 && lines[i - 1]!.includes("|")) {
        toRemove.add(i - 1);
      }
      // Subsequent data rows
      let j = i + 1;
      while (j < lines.length && lines[j]!.includes("|")) {
        toRemove.add(j);
        j++;
      }
    }
  }

  return lines.filter((_, i) => !toRemove.has(i)).join("\n");
}

/** Truncates text at or before the limit, favoring sentence boundaries over hard cuts. */
function truncateToLimit(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const candidate = text.slice(0, limit);
  const sentenceRe = /[.!?…][)"\x27»”’\]}]*(?=\s|$)/gu;
  let lastBoundaryIndex = -1;
  let match: RegExpExecArray | null;

  while ((match = sentenceRe.exec(candidate)) !== null) {
    lastBoundaryIndex = match.index + match[0].length;
  }

  if (lastBoundaryIndex > 0) {
    return candidate.slice(0, lastBoundaryIndex).trim();
  }

  const lastNewline = candidate.lastIndexOf("\n");
  if (lastNewline > 0) {
    return candidate.slice(0, lastNewline).trim();
  }

  return candidate.trim();
}

/** BCP-47 code this text most likely is, from the script it is written in. */
export function detectLanguage(text: string): "ru-RU" | "en-US" {
  const cyrillicMatches = text.match(/\p{sc=Cyrillic}/gu);
  const cyrillicCount = cyrillicMatches !== null ? cyrillicMatches.length : 0;
  if (cyrillicCount === 0) {
    return "en-US";
  }

  const latinMatches = text.match(/\p{sc=Latin}/gu);
  const latinCount = latinMatches !== null ? latinMatches.length : 0;

  return cyrillicCount >= latinCount ? "ru-RU" : "en-US";
}

/** Markdown in, speakable plain text out. Never throws; may return "". */
export function toSpeakable(markdown: string): string {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return "";
  }

  let text = markdown.replace(/\r\n|\r/g, "\n");

  // Fenced code blocks
  text = text.replace(
    /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\n|$)|$)/g,
    "\n\n",
  );

  // Indented code blocks
  text = text.replace(
    /(?:^|\n\n)(?:(?: {4}|\t)(?![-*+] |\d+[.)] |>)[^\n]*(?:\n|$))+/g,
    "\n\n",
  );

  // HTML comments, script tags, style tags
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Footnote definitions and references
  text = text.replace(/^[ \t]*\[\^[^\]]+\]:[ \t]+.*$/gm, "");
  text = text.replace(/\[\^[^\]]+\]/g, "");

  // Images: removed entirely including alt text
  text = text.replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, "");

  // Link definitions, autolinks, reference links, inline links, bare URLs
  text = text.replace(/^[ \t]*\[[^\]]+\]:[ \t]+.*$/gm, "");
  text = text.replace(/<[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^>]+>/g, "");
  text = text.replace(/<mailto:[^>]+>/g, "");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/\bhttps?:\/\/[^\s<>()]+(?=[.,;:!?]?(?:\s|$))/g, "");

  // Tables
  text = stripTables(text);

  // Headings: Setext underlines must precede thematic breaks
  text = text.replace(/^([^\n]+)\n[ \t]*(=+|-+)[ \t]*$/gm, (_m, heading) =>
    ensureTerminalPunctuation(heading),
  );
  text = text.replace(
    /^[ \t]{0,3}#{1,6}[ \t]+([^\n#]*?)(?:[ \t]+#+)?[ \t]*$/gm,
    (_m, heading) => ensureTerminalPunctuation(heading),
  );

  // Thematic breaks
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}[ \t]*$/gm, "");

  // Blockquotes: strip > markers and ensure terminal punctuation on quote text
  text = text.replace(/^[ \t]*(?:>[ \t]*)+([^\n]*)$/gm, (_m, content) => {
    const trimmed = content.trim();
    if (/^(?:[-*+]|\d+[.)]|\[[ xX]\])/.test(trimmed)) {
      return trimmed;
    }
    return ensureTerminalPunctuation(trimmed);
  });

  // Task boxes
  text = text.replace(/\[[ xX]\][ \t]*/g, "");

  // List markers: strip markers and ensure terminal punctuation on item text
  text = text.replace(
    /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.*)$/gm,
    (_m, content) => ensureTerminalPunctuation(content),
  );

  // Inline code: strip backticks while preserving identifier content
  text = text.replace(/``([\s\S]*?)``/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");

  // Emphasis and strikethrough: word boundary check protects intra-word underscores
  text = text.replace(/\*\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*\*/g, "$1");
  text = text.replace(/\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*/g, "$1");
  text = text.replace(/\*([^\s*](?:[\s\S]*?[^\s*])?)\*/g, "$1");
  text = text.replace(/~~([^\s~](?:[\s\S]*?[^\s~])?)~~/g, "$1");
  text = text.replace(
    /(^|[\s\p{P}])___([^\s_](?:[\s\S]*?[^\s_])?)___(?=[\s\p{P}]|$)/gu,
    "$1$2",
  );
  text = text.replace(
    /(^|[\s\p{P}])__([^\s_](?:[\s\S]*?[^\s_])?)__(?=[\s\p{P}]|$)/gu,
    "$1$2",
  );
  text = text.replace(
    /(^|[\s\p{P}])_([^\s_](?:[\s\S]*?[^\s_])?)_(?=[\s\p{P}]|$)/gu,
    "$1$2",
  );

  // Raw HTML tags and entities
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  text = decodeHtmlEntities(text);

  // Emojis and pictographs
  text = text.replace(
    /\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}]|[\u{E0020}-\u{E007F}]|[\uFE00-\uFE0F]|\u200D/gu,
    "",
  );

  // Whitespace normalization
  text = text.replace(/[^\S\n]+/g, " ");
  text = text.replace(/ +([.,;:!?])(?=\s|$)/g, "$1");
  text = text.replace(/ +$/gm, "").replace(/^ +/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  // Length limit truncation
  return truncateToLimit(text, MAX_SPEAKABLE_CHARS);
}
