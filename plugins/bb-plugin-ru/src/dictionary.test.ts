import { describe, expect, it } from "vitest";

import { DICTIONARY, DICTIONARY_SIZE } from "./dictionary.js";
import { normalizeKey } from "./translate.js";

/**
 * Слова, с которых начинается кусок предложения, а не самостоятельная подпись.
 * Такой ключ означает, что в словарь просочился текст ссылки или хвост фразы,
 * разрезанной тегом: точная подмена даст полуанглийскую строку в неверном
 * падеже («configured from его страницу настроек»).
 */
const FRAGMENT_STARTERS = new Set([
  "its",
  "the",
  "on",
  "in",
  "of",
  "at",
  "from",
  "and",
  "or",
  "a",
  "an",
  "to",
  "for",
  "with",
  "by",
]);

describe("словарь", () => {
  it("непустой и совпадает с объявленным размером", () => {
    expect(DICTIONARY_SIZE).toBeGreaterThan(400);
    expect(Object.keys(DICTIONARY)).toHaveLength(DICTIONARY_SIZE);
  });

  it("ключи нормализованы — иначе они никогда не совпадут с DOM", () => {
    for (const key of Object.keys(DICTIONARY)) {
      expect(key).toBe(normalizeKey(key));
    }
  });

  it("не содержит HTML-сущностей ни в ключах, ни в значениях", () => {
    for (const [key, value] of Object.entries(DICTIONARY)) {
      expect(key).not.toMatch(/&[a-z]+;/);
      expect(value).not.toMatch(/&[a-z]+;/);
    }
  });

  it("не содержит кусков предложений со строчной буквы", () => {
    const offenders = Object.keys(DICTIONARY).filter((key) => {
      const first = key.split(" ")[0] ?? "";
      return first === first.toLowerCase() && FRAGMENT_STARTERS.has(first);
    });
    expect(offenders).toEqual([]);
  });

  it("не переводит строку сама в себя", () => {
    for (const [key, value] of Object.entries(DICTIONARY)) {
      expect(value).not.toBe(key);
      expect(value.trim()).not.toBe("");
    }
  });
});
