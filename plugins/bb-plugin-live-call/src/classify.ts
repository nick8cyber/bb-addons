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

export function normalizeUtterance(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
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
