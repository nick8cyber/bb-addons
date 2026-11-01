export type ReviewText = { summary: string; details: string };

type FieldName = keyof ReviewText;

type Range = { start: number; end: number };

type ProtectedToken = {
  token: string;
  field: FieldName;
  original: string;
};

const TRANSLATION_NOTICE =
  "Не удалось перевести ревью на русский; показан оригинал";
const MAX_TRANSLATION_JSON_BYTES = 256 * 1024;
const CYRILLIC_SHARE_THRESHOLD = 0.6;
const ENGLISH_WORD_RUN_LIMIT = 4;

const FENCED_CODE =
  /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE = /(`+)([^`\n]+?)\1/g;
const BLOCKQUOTE = /^[ \t]{0,3}>[^\n]*$/gm;
const URL = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"“”«»`]+/g;
const PATH =
  /(?:(?<![\w.-])(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/|\\)[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*|\b[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+)(?::[0-9]+(?:-[0-9]+)?)?/g;
const FILE_WITH_LINE =
  /\b[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::[0-9]+(?:-[0-9]+)?)?\b/g;
const BARE_LINE = /\b[A-Za-z0-9_.-]+:[0-9]+(?:-[0-9]+)?\b/g;
const DOUBLE_QUOTED = /"(?:[^"\\\n]|\\.)*"/g;
const CURLY_DOUBLE_QUOTED = /“[^”\n]*”/g;
const GUILLEMET_QUOTED = /«[^»\n]*»/g;
const NUMBERS = /\bv?\d+(?:[.,:/]\d+)*\b/g;

const IDENTIFIERS =
  /\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b|\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b|\b[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[A-Z][A-Z0-9]{1,}\b/g;
const TECHNICAL_WORDS =
  /(?<![\p{L}\p{N}_-])(?:timeouts?|retry|retries|retrying|cache|apis?|sdks?|json|http)(?![\p{L}\p{N}_-])/giu;
const NAME_TOKEN =
  /[\p{Script=Latin}\p{Script=Cyrillic}]+(?:['’][\p{Script=Latin}\p{Script=Cyrillic}]+)*/gu;
const ORDINARY_ENGLISH_WORD = /^[A-Za-z]+(?:['’][A-Za-z]+)*$/;
const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u;
const CYRILLIC_LETTERS = /\p{Script=Cyrillic}/gu;
const LATIN_LETTERS = /\p{Script=Latin}/gu;
const PLACEHOLDER = /\[\[ADVISOR_[^\]]*\]\]/gi;
const NONE_OR_EMPTY = /^(?:[-*]\s*)?none[.!]?$/i;

const PROTECTED_PATTERNS = [
  FENCED_CODE,
  INLINE_CODE,
  BLOCKQUOTE,
  URL,
  PATH,
  FILE_WITH_LINE,
  BARE_LINE,
  DOUBLE_QUOTED,
  CURLY_DOUBLE_QUOTED,
  GUILLEMET_QUOTED,
  NUMBERS,
];

export function russianReviewInstruction(): string {
  return [
    "Всегда пиши summary и details ревью по-русски.",
    "",
    "Сохраняй служебную структуру ответа без изменений:",
    "- английские метки полей severity, key, summary, details, resolved;",
    "- значения severity: pass|nit|concern|blocker — не переводить;",
    "- key — Latin slug: для новой находки обычный slug по правилам Advisor, для повторной — прежний key; не переводить;",
    "- resolved — прежние ключи (Latin), не переводить;",
    "- литерал none оставляй ровно как none;",
    "- маркеры ADVISOR_RESULT и END_ADVISOR_RESULT не меняй.",
    "",
    "Переводи только текст значений summary и details.",
  ].join("\n");
}

export function needsRussianTranslation(review: ReviewText): boolean {
  return (
    fieldNeedsTranslation(review.summary) ||
    fieldNeedsTranslation(review.details)
  );
}

export function prepareRussianTranslation(review: ReviewText): {
  prompt: string;
  parse(output: string): ReviewText | null;
} {
  const records: ProtectedToken[] = [];
  const forbidden = [review.summary, review.details];
  const protectedReview: ReviewText = {
    summary: protectField(review.summary, "summary", records, forbidden),
    details: protectField(review.details, "details", records, forbidden),
  };

  return {
    prompt: buildTranslationPrompt(protectedReview),
    parse(output: string): ReviewText | null {
      try {
        return parseTranslation(output, records);
      } catch {
        return null;
      }
    },
  };
}

export function withTranslationFailureNotice(review: ReviewText): ReviewText {
  if (review.details.includes(TRANSLATION_NOTICE)) {
    return { summary: review.summary, details: review.details };
  }
  const details = review.details.trim()
    ? `${review.details}\n\n${TRANSLATION_NOTICE}`
    : TRANSLATION_NOTICE;
  return { summary: review.summary, details };
}

function fieldNeedsTranslation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || NONE_OR_EMPTY.test(trimmed)) return false;

  const prose = stripProtectedText(text);
  const cyrillic = countMatches(prose, CYRILLIC_LETTERS);
  const latin = countMatches(prose, LATIN_LETTERS);
  if (cyrillic + latin === 0) return false;
  if (longestEnglishRun(prose) >= ENGLISH_WORD_RUN_LIMIT) return true;
  return cyrillic / (cyrillic + latin) < CYRILLIC_SHARE_THRESHOLD;
}

function stripProtectedText(text: string): string {
  const ranges = findProtectedRanges(text);
  const withoutProtected =
    ranges.length === 0 ? text : replaceRanges(text, ranges, () => " ");
  return withoutProtected
    .replace(IDENTIFIERS, " ")
    .replace(TECHNICAL_WORDS, " ");
}

function replaceRanges(
  text: string,
  ranges: Range[],
  replacement: (range: Range) => string,
): string {
  let result = "";
  let position = 0;
  for (const range of ranges) {
    result += text.slice(position, range.start);
    result += replacement(range);
    position = range.end;
  }
  return result + text.slice(position);
}

function findProtectedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined || match[0].length === 0) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges: Range[]): Range[] {
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return text.match(pattern)?.length ?? 0;
}

function longestEnglishRun(prose: string): number {
  let longest = 0;
  let current = 0;
  for (const match of prose.matchAll(NAME_TOKEN)) {
    const word = match[0];
    if (CYRILLIC_LETTER.test(word)) {
      current = 0;
    } else if (ORDINARY_ENGLISH_WORD.test(word)) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function protectField(
  text: string,
  field: FieldName,
  records: ProtectedToken[],
  forbidden: string[],
): string {
  const ranges = findProtectedRanges(text);
  if (ranges.length === 0) return text;

  let index = 0;
  return replaceRanges(text, ranges, (range) => {
    const original = text.slice(range.start, range.end);
    const token = createToken(field, index, records, forbidden);
    index += 1;
    records.push({ token, field, original });
    return token;
  });
}

function createToken(
  field: FieldName,
  index: number,
  records: ProtectedToken[],
  forbidden: string[],
): string {
  const prefix = field === "summary" ? "S" : "D";
  for (;;) {
    const token = `[[ADVISOR_${prefix}${index}_${randomChunk()}]]`;
    if (records.some((record) => record.token === token)) continue;
    if (forbidden.some((text) => text.includes(token))) continue;
    return token;
  }
}

function randomChunk(): string {
  return `${Math.random().toString(36).slice(2, 10)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function buildTranslationPrompt(review: ReviewText): string {
  return [
    "Переведи готовое ревью Advisor на русский язык.",
    "",
    "Это только перевод. Не проводи новое ревью, не вызывай инструменты, не меняй severity, не добавляй и не закрывай находки.",
    "",
    "Правила:",
    "- Переведи на русский только прозу в полях summary и details.",
    "- Плейсхолдеры вида [[ADVISOR_...]] заменяют код, команды, URL, пути, цитаты и числа. Сохрани каждый плейсхолдер без изменений, ровно один раз и в том же поле, где он был.",
    "- Литерал none оставь как none.",
    "- Верни только валидный JSON без markdown и пояснений, ровно с двумя строковыми полями summary и details. Никаких других полей, включая severity, key и resolved, быть не должно.",
    '- Формат: {"summary":"...","details":"..."}',
    "",
    "Исходное ревью:",
    JSON.stringify(review),
  ].join("\n");
}

function parseTranslation(
  output: string,
  records: ProtectedToken[],
): ReviewText | null {
  if (typeof output !== "string") return null;
  if (Buffer.byteLength(output, "utf8") > MAX_TRANSLATION_JSON_BYTES) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isReviewText(parsed)) return null;

  const known = new Set(records.map((record) => record.token));
  for (const text of [parsed.summary, parsed.details]) {
    PLACEHOLDER.lastIndex = 0;
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (!known.has(match[0])) return null;
    }
  }

  for (const record of records) {
    const inSummary = countOccurrences(parsed.summary, record.token);
    const inDetails = countOccurrences(parsed.details, record.token);
    if (record.field === "summary") {
      if (inSummary !== 1 || inDetails !== 0) return null;
    } else if (inDetails !== 1 || inSummary !== 0) {
      return null;
    }
  }

  for (const field of ["summary", "details"] as const) {
    const candidate = removeFieldTokens(parsed[field], field, records);
    if (findProtectedRanges(candidate).length > 0) return null;
  }

  const restored: ReviewText = {
    summary: restoreField(parsed.summary, "summary", records),
    details: restoreField(parsed.details, "details", records),
  };
  if (needsRussianTranslation(restored)) return null;
  return restored;
}

function isReviewText(value: unknown): value is ReviewText {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 2) return false;
  if (!keys.includes("summary") || !keys.includes("details")) return false;
  const summary = (value as Record<string, unknown>).summary;
  const details = (value as Record<string, unknown>).details;
  return typeof summary === "string" && typeof details === "string";
}

function countOccurrences(text: string, token: string): number {
  let count = 0;
  let position = 0;
  for (;;) {
    const found = text.indexOf(token, position);
    if (found === -1) return count;
    count += 1;
    position = found + token.length;
  }
}

function removeFieldTokens(
  text: string,
  field: FieldName,
  records: ProtectedToken[],
): string {
  let result = text;
  for (const record of records) {
    if (record.field !== field) continue;
    result = result.split(record.token).join(" ");
  }
  return result;
}

function restoreField(
  text: string,
  field: FieldName,
  records: ProtectedToken[],
): string {
  let result = text;
  for (const record of records) {
    if (record.field !== field) continue;
    result = result.split(record.token).join(record.original);
  }
  return result;
}
