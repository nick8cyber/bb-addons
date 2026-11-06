// Детекторы чувствительного текста. Чистые функции — тестируются без DOM.

export interface MatchSpan {
  start: number;
  end: number;
}

/** Префиксы, которые bb ставит своим id. */
const BB_ID_PREFIXES = ["thr", "proj", "env", "msg", "mem", "host", "src", "mach"];

/** Префиксы id, которые выдаёт bb (thr_…, proj_…, env_…) и похожие системы. */
const ID_PREFIXES = [
  "thr", "proj", "env", "msg", "mem", "host", "mach", "machine", "src", "run",
  "task", "tsk", "auto", "acct", "usr", "user", "org", "ws", "sess", "wf",
  "art", "att", "dev", "srv", "key", "tok", "req", "evt", "job", "pl", "plg",
  "prv", "cmp", "inv", "sub", "cus", "ch", "pi", "pm", "sk", "pk", "rk",
];

const TLDS =
  "com|org|net|io|dev|app|ai|ru|su|by|kz|ua|uk|de|fr|nl|eu|us|co|info|biz|xyz|cloud|tech|site|online|store|space|gg|tv|cc|pro|team|digital|studio|agency|local|internal|lan|home|corp";

// Порядок не важен: пересечения склеиваются в mergeSpans.
const BUILTIN_PATTERNS: RegExp[] = [
  // Почты.
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu,
  // URL целиком (в них инстансы, токены, пути).
  /\b(?:https?|wss?|ssh|git|ftp):\/\/[^\s<>"'`)\]]+/gu,
  // Пути: абсолютные unix, ~/…, Windows.
  /(?<![\p{L}\p{N}_:/.\\-])(?:~|\/(?:home|Users|root|mnt|media|opt|srv|var|etc|tmp|private|Volumes|data|workspace|workspaces|usr|run|snap))(?:\/[^\s/<>"'`|:;,()[\]{}]+)+\/?/gu,
  /(?<![\p{L}\p{N}_:/.\\-])(?:\/[\p{L}\p{N}._@+-]+){2,}\/?/gu,
  /\b[A-Za-z]:\\(?:[^\s\\<>"'`|:*?]+\\?)+/gu,
  // id bb: <thread>, <memory> — у этих префиксов цифра не нужна.
  new RegExp(`\\b(?:${BB_ID_PREFIXES.join("|")})_[a-z0-9]{6,}(?:_[a-z0-9]+)*\\b`, "gu"),
  // Прочие id с префиксом: только если есть цифра (иначе это snake_case-слово).
  new RegExp(`\\b(?:${ID_PREFIXES.join("|")})_(?=[A-Za-z0-9_-]*\\d)[A-Za-z0-9][A-Za-z0-9_-]{4,}\\b`, "gu"),
  // UUID.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
  // Длинные hex (SHA, токены, хэши).
  /\b[0-9a-f]{12,}\b/giu,
  // Ключи и токены: sk-…, ghp_…, xoxb-…, AKIA…, JWT.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_-]{10,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  // IPv4 и IPv6.
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{2,5})?\b/gu,
  /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/giu,
  // Домены и хосты: sursun.getbb.app, a1.example.ru.
  new RegExp(`(?<![\\p{L}\\p{N}_@./-])(?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?\\.)+(?:${TLDS})\\b(?::\\d{2,5})?(?![\\p{L}\\p{N}_-])`, "giu"),
  // Телефоны в международном формате.
  /\+\d[\d\s().-]{8,}\d/gu,
  // @упоминания (логины GitHub/Telegram).
  /(?<![\p{L}\p{N}_.@])@[A-Za-z0-9_][A-Za-z0-9_.-]{2,}/gu,
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Нормализует список слов: без дублей, длиной от 3 символов, длинные первыми. */
export function normalizeTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (term.length < 3 || term.length > 300) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Регулярка по словам из списка: границы слова Unicode-aware, без учёта регистра. */
export function buildTermsPattern(terms: readonly string[]): RegExp | null {
  const list = normalizeTerms(terms);
  if (list.length === 0) return null;
  const body = list.map(escapeRegExp).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, "giu");
}

export function mergeSpans(spans: MatchSpan[]): MatchSpan[] {
  if (spans.length < 2) return spans;
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: MatchSpan[] = [{ ...spans[0]! }];
  for (let i = 1; i < spans.length; i++) {
    const span = spans[i]!;
    const last = out[out.length - 1]!;
    if (span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

export interface Detector {
  find(text: string): MatchSpan[];
}

/** Имя и фамилия: два слова подряд с заглавной (Иван Петров, John Smith). */
const PERSON_NAME_PATTERN =
  /(?<![\p{L}\p{N}_])\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?\s+\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?(?![\p{L}\p{N}_])/gu;

export interface DetectorOptions {
  /** Искать имена людей эвристикой «два слова с заглавной». */
  names?: boolean;
}

export function createDetector(terms: readonly string[], options: DetectorOptions = {}): Detector {
  const patterns = [...BUILTIN_PATTERNS];
  if (options.names) patterns.push(PERSON_NAME_PATTERN);
  const termsPattern = buildTermsPattern(terms);
  if (termsPattern) patterns.push(termsPattern);
  return {
    find(text: string): MatchSpan[] {
      if (text.length < 3) return [];
      const spans: MatchSpan[] = [];
      for (const pattern of patterns) {
        // Хвостовую пунктуацию срезаем только у шаблонов: у слов из списка она своя.
        const trimTail = pattern !== termsPattern;
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const start = match.index ?? 0;
          let end = start + match[0].length;
          // Хвостовая пунктуация предложения — не часть пути/URL/домена.
          while (trimTail && end > start && /[.,;:!?]/.test(text[end - 1]!)) end--;
          if (end > start) spans.push({ start, end });
        }
      }
      return mergeSpans(spans);
    },
  };
}
