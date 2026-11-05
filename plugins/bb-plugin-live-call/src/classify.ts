/**
 * Детерминированная классификация ответа владельца (спека §7.1 п. 5).
 * Чистая функция: решает сервер, слова сверяются со списками, модель не участвует.
 */
import { MAX_UTTERANCE_WORDS } from "./contract.js";

export type ConfirmClass = "C" | "P" | "L";

export interface ConfirmWords {
  refuse: string[];
  confirm: string[];
  permit: string[];
  launch: string[];
  /** Слово-исключение для конкретного инструмента, напр. «останавливай» для stop_thread. */
  toolExtra?: string[];
}

export const DEFAULT_WORDS: ConfirmWords = {
  refuse: ["нет", "не", "отмена", "отмени", "отбой", "стоп", "подожди", "погоди", "потом", "но"],
  confirm: ["да", "давай", "подтверждаю", "отправляй", "ок", "окей", "верно"],
  permit: ["разрешаю", "разреши", "одобряю"],
  launch: ["запускай", "запусти", "запускаем", "раздавай", "раздай"],
  toolExtra: [],
};

/** Вежливые слова, которые не делают реплику неоднозначной (спека §7.1 п. 5.2). */
export const POLITE_WORDS = ["ну", "пожалуйста", "конечно", "уже"];

export type Verdict = "approved" | "hint" | "cancelled" | "expired" | "not_confirmed";

/**
 * Короткие ответы, которые распознавание Gemini иногда пишет латиницей
 * («Да.» → «da», приёмка 02.11). Без этого «да» на подтверждение отправки
 * засчитывалось как шум — отмена. Только целые слова и только ответы.
 */
const LATIN_ANSWERS: Record<string, string> = {
  da: "да",
  net: "нет",
  ok: "ок",
  okay: "окей",
  okey: "окей",
  stop: "стоп",
  otmena: "отмена",
  davai: "давай",
  davay: "давай",
  zapuskay: "запускай",
  zapuskai: "запускай",
  zapusti: "запусти",
  razreshayu: "разрешаю",
  razreshaju: "разрешаю",
};

export function normalizeUtterance(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => LATIN_ANSWERS[w] ?? w);
}

export function classify(
  rawText: string,
  cls: ConfirmClass,
  words: ConfirmWords,
): Verdict {
  const words_norm = normalizeUtterance(rawText);
  if (words_norm.length === 0) return "cancelled";

  // 1. Отказ или стоп-слово сильнее согласия.
  if (words_norm.some((w) => words.refuse.includes(w))) return "cancelled";

  // 2. Длинная реплика — неоднозначно.
  if (words_norm.length > MAX_UTTERANCE_WORDS) return "cancelled";

  const allowed = new Set<string>([...POLITE_WORDS]);
  if (cls === "C") {
    for (const w of words.confirm) allowed.add(w);
    for (const w of words.toolExtra ?? []) allowed.add(w);
  } else {
    // Для L и P слова класса C — допустимый довесок к глаголу («да, запускай»).
    for (const w of words.confirm) allowed.add(w);
    for (const w of cls === "L" ? words.launch : words.permit) allowed.add(w);
    for (const w of words.toolExtra ?? []) allowed.add(w);
  }
  const residual = words_norm.filter((w) => !allowed.has(w));
  if (residual.length > 0) return "cancelled";

  const has = (list: string[]) => words_norm.some((w) => list.includes(w));

  if (cls === "L") {
    if (has(words.launch)) return "approved";
    // Одно «да» запуск не подтверждает — модель подсказывает слово.
    return "hint";
  }
  if (cls === "P") {
    if (has(words.permit)) return "approved";
    return "hint";
  }
  // C: короткое согласие.
  if (has(words.confirm) || has(words.toolExtra ?? [])) return "approved";
  return "cancelled";
}

/** Слова доклада об исполнении для false_claim (спека §7.1 п. 9). */
export const FALSE_CLAIM_WORDS = new Set([
  "отправлено",
  "отправлен",
  "отправлена",
  "отправил",
  "отправила",
  "передано",
  "передан",
  "передала",
  "готово",
  "выполнено",
  "выполнена",
  "выполнил",
  "выполнила",
  "сделано",
  "сделал",
  "сделала",
  "создано",
  "создана",
  "создал",
  "создала",
  "запущено",
  "запустил",
  "запустила",
]);

/**
 * Проверка слова реплики на совпадение со словами эхо-набора (спека §7.1 п. 3.1, п. 5).
 * Считается эхом, если:
 * - совпадает целиком
 * - совпадают 6-буквенные корни
 * - обрывок-префикс слова из набора длины >= 3 (напр. «отправ» ← «отправить»)
 */
export function isEchoWord(word: string, echoWords: Set<string>): boolean {
  if (echoWords.has(word)) return true;
  for (const ew of echoWords) {
    if (word.length >= 6 && ew.length >= 6 && word.slice(0, 6) === ew.slice(0, 6)) {
      return true;
    }
    if (word.length >= 3 && ew.startsWith(word)) {
      return true;
    }
    if (ew.length >= 6 && word.length >= 6 && word.startsWith(ew.slice(0, 6))) {
      return true;
    }
  }
  return false;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const AUX_WORDS = new Set(["было", "будет", "будут", "бы"]);

export function prepClaimText(t: string): string {
  return t
    .replace(/(?<=[\p{L}\p{N}])[-‐‑](?=[\p{L}\p{N}])/gu, "")
    .replace(/’/g, "'");
}

interface ClaimToken {
  word: string;
  start: number;
}

export function tokenizeClaimWords(text: string): ClaimToken[] {
  const tokens: ClaimToken[] = [];
  const regex = /[\p{L}\p{N}]+(?:(?<=\p{L})['’](?=\p{L})[\p{L}\p{N}]+)*/gu;
  for (const m of text.matchAll(regex)) {
    tokens.push({
      word: m[0].toLowerCase().replaceAll("ё", "е"),
      start: m.index,
    });
  }
  return tokens;
}

export function claimWordsOf(t: string): string[] {
  return tokenizeClaimWords(prepClaimText(t)).map((x) => x.word);
}

function findOccurrences(haystack: string[], needle: string[]): number[] {
  const res: number[] = [];
  if (needle.length === 0 || needle.length > haystack.length) return res;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) res.push(i);
  }
  return res;
}

/**
 * Проверка хода модели на ложный доклад об исполнении при ожидающем подтверждении
 * по детерминированному алгоритму сопоставления (§7.1 п. 9.1).
 */
export function isFalseClaim(
  turnText: string,
  say: string,
  actionTexts?: string[] | string,
): boolean {
  if (!turnText) return false;

  const prepTurn = prepClaimText(turnText);
  const turnTokens = tokenizeClaimWords(prepTurn);
  const tw = turnTokens.map((t) => t.word);
  const N = tw.length;
  if (N === 0) return false;

  const marked = new Array(N).fill(false);

  // Шаг 2: Источники текста действия
  // Внутри isFalseClaim НЕ разбирать кавычки say и НЕ добавлять карточку.
  // При явно пустом списке источников шаг 4 пропускается.
  const rawSources: string[] = [];
  if (Array.isArray(actionTexts)) {
    for (const a of actionTexts) {
      if (typeof a === "string" && a.trim()) rawSources.push(a.trim());
    }
  } else if (typeof actionTexts === "string" && actionTexts.trim()) {
    rawSources.push(actionTexts.trim());
  }

  const srcs = rawSources.map((s) => claimWordsOf(s)).filter((s) => s.length > 0);

  // Шаг 3: Полные фрагменты
  const sw = claimWordsOf(say);
  for (const i of findOccurrences(tw, sw)) {
    for (let j = 0; j < sw.length; j++) marked[i + j] = true;
  }
  for (const s of srcs) {
    if (s.length >= 2) {
      for (const i of findOccurrences(tw, s)) {
        for (let j = 0; j < s.length; j++) marked[i + j] = true;
      }
    }
  }

  // Шаг 4: Цитаты
  if (srcs.length > 0) {
    for (let p = 0; p < prepTurn.length; p++) {
      const ch = prepTurn[p];
      const open =
        ch === "«" ||
        ((ch === '"' || ch === "'" || ch === "“" || ch === "„") &&
          (p === 0 || !LETTER_OR_DIGIT.test(prepTurn[p - 1])) &&
          LETTER_OR_DIGIT.test(prepTurn[p + 1] ?? ""));
      if (!open) continue;

      const i0 = turnTokens.findIndex((x) => x.start > p);
      if (i0 < 0) continue;

      let best = 0;
      for (let k = 1; i0 + k <= N; k++) {
        const seq = tw.slice(i0, i0 + k);
        if (srcs.some((s) => findOccurrences(s, seq).length > 0)) {
          best = k;
        } else {
          break;
        }
      }
      for (let j = 0; j < best; j++) {
        marked[i0 + j] = true;
      }
    }
  }

  // Шаг 5: Доклад
  return tw.some((w, i) => {
    if (marked[i] || !FALSE_CLAIM_WORDS.has(w)) return false;
    const p1 = tw[i - 1];
    const p2 = tw[i - 2];
    const p1Unmarked = i > 0 && !marked[i - 1];
    const p2Unmarked = i > 1 && !marked[i - 2];

    if (p1Unmarked && p1 === "не") return false;
    if (p1Unmarked && (p1 === "будет" || p1 === "будут" || p1 === "бы")) return false;
    if (p2Unmarked && p2 === "не" && p1Unmarked && AUX_WORDS.has(p1)) return false;
    if (w === "готово") {
      const nextWord = tw[i + 1];
      if (nextWord === "к" || nextWord === "для") return false;
    }
    return true;
  });
}
