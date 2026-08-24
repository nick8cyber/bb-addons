#!/usr/bin/env node
/**
 * Собирает src/dictionary.ts из dict/core.json и dict/src/batch*.json.
 *
 * Пакеты batch*.json — машинный перевод строк, вытащенных из исходников bb;
 * core.json — выверенные вручную значения, они перекрывают пакеты. Пустое
 * значение ru означает «оставить английским» и в словарь не попадает.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dictDir = join(root, "dict");
const out = join(root, "src", "dictionary.ts");

/**
 * Строки вытащены из JSX, поэтому несут HTML-сущности (`Couldn&apos;t`), а в DOM
 * тот же текст живёт уже раскодированным. Без этого шага такие ключи не
 * совпадут никогда.
 */
const ENTITIES = {
  "&apos;": "'",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&quot;": '"',
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
};

function decodeEntities(value) {
  return value.replace(
    /&(?:apos|rsquo|lsquo|quot|ldquo|rdquo|nbsp|mdash|ndash|hellip|amp|lt|gt);/g,
    (match) => ENTITIES[match],
  );
}

function readEntries(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: ожидался JSON-массив`);
  }
  return parsed.map((entry, index) => {
    if (typeof entry?.en !== "string" || typeof entry?.ru !== "string") {
      throw new Error(`${path}[${index}]: нужны строковые поля en и ru`);
    }
    return {
      en: decodeEntities(entry.en).replace(/\s+/g, " ").trim(),
      ru: decodeEntities(entry.ru).trim(),
    };
  });
}

const batchDir = join(dictDir, "src");
const sources = readdirSync(batchDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => join(batchDir, name));

/**
 * Ключи, которые нельзя переводить, даже если перевод есть: это куски
 * предложения, разрезанного ссылкой или inline-кодом. Точная подмена такого
 * куска даёт полуанглийскую фразу в неправильном падеже — хуже, чем оригинал.
 */
const excluded = new Map(
  JSON.parse(readFileSync(join(dictDir, "exclude.json"), "utf8")).map(
    (entry) => [decodeEntities(entry.en).replace(/\s+/g, " ").trim(), entry.why],
  ),
);

const merged = new Map();
let skippedEmpty = 0;
let skippedIdentical = 0;
let skippedExcluded = 0;

for (const source of [...sources, join(dictDir, "core.json")]) {
  for (const { en, ru } of readEntries(source)) {
    if (en.length === 0) continue;
    if (ru.length === 0) {
      skippedEmpty += 1;
      continue;
    }
    if (ru === en) {
      skippedIdentical += 1;
      continue;
    }
    if (excluded.has(en)) {
      skippedExcluded += 1;
      continue;
    }
    merged.set(en, ru);
  }
}

const keys = [...merged.keys()].sort((left, right) =>
  left < right ? -1 : left > right ? 1 : 0,
);

const body = keys
  .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(merged.get(key))},`)
  .join("\n");

writeFileSync(
  out,
  `/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактировать вручную.
 * Источник: dict/src/batch*.json + dict/core.json, сборка: npm run dict
 */

export const DICTIONARY: Readonly<Record<string, string>> = {
${body}
};

export const DICTIONARY_SIZE = ${keys.length};
`,
  "utf8",
);

console.log(
  `dictionary: ${keys.length} строк из ${sources.length + 1} файлов ` +
    `(без перевода: ${skippedEmpty}, совпало с оригиналом: ${skippedIdentical}, ` +
    `исключено как фрагмент: ${skippedExcluded})`,
);
