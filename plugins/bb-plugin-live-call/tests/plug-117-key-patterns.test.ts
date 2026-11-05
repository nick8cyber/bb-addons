/**
 * Шаблоны ключей с уже замаскированным точным значением внутри (§14.6, ревью PLUG-117 round-10, пробы Opus).
 */
import { describe, expect, it } from "vitest";
import { maskSecrets } from "../src/secret-filter.js";

// Round-10 (Opus): шаблоны ключей с «*» по 39ab1f8. Все ключи фиктивные, длины как у настоящих форматов.
const fill = (n: number, ch = "Z") => ch.repeat(n);
// Допустимое точное значение длиной L внутри ключа: после маски ключ короче на L−3.
const inner = (len: number) => "Q9".repeat(Math.ceil(len / 2)).slice(0, len);

describe("R10-1 ключ закрыт целиком, если внутри было допустимое значение (§14.6, 39ab1f8)", () => {
  const cases: Array<[string, string, string]> = [
    // [имя, ключ, допустимое значение внутри]
    ["AIza (39 = 4+35), значение 3 символа", "AIza" + fill(10) + "Q9Q" + fill(22), "Q9Q"],
    ["AIza (39 = 4+35), значение 4 символа", "AIza" + fill(10) + inner(4) + fill(21), inner(4)],
    ["AIza (39 = 4+35), значение 8 символов", "AIza" + fill(10) + inner(8) + fill(17), inner(8)],
    ["ghp_ (4+36), значение 3 символа", "ghp_" + fill(10) + "Q9Q" + fill(23), "Q9Q"],
    ["ghp_ (4+36), значение 4 символа", "ghp_" + fill(10) + inner(4) + fill(22), inner(4)],
    ["ghp_ (4+36), значение 8 символов", "ghp_" + fill(10) + inner(8) + fill(18), inner(8)],
    ["github_pat_ (11+82), значение 8 символов", "github_pat_" + fill(30) + inner(8) + fill(44), inner(8)],
    ["sk- (3+48), значение 12 символов", "sk-" + fill(10) + inner(12) + fill(26), inner(12)],
    ["xoxb- , значение 8 символов", "xoxb-" + fill(10) + inner(8) + fill(20), inner(8)],
    ["Bearer, значение 8 символов", "Bearer " + fill(10) + inner(8) + fill(20), inner(8)],
    ["AIza, значение в конце ключа", "AIza" + fill(31) + inner(4), inner(4)],
  ];
  for (const [name, key, val] of cases)
    it(`${name}: хвоста ключа нет`, () => {
      const out = maskSecrets(`upstream said ${key} done`, [val]);
      expect(out).not.toMatch(/ZZZZ/);
    });
});

describe("R10-2 «*» не даёт ложных масок обычного текста", () => {
  for (const s of ["see task-force and risk-free*", "a * b ** c", "xoxb is * fine"])
    it(`не тронуто: ${s}`, () => expect(maskSecrets(s, [])).toBe(s));
  // Принятая цена правила «прогон с * закрывается без длины» (§14.6): префикс ключа со звёздочкой
  // маскируется лишний раз — безопасная сторона (ревью PLUG-117 round-10).
  for (const s of ["ghp_short* ok", "AIza* only"])
    it(`маскируется лишний раз (безопасно): ${s}`, () => expect(maskSecrets(s, [])).not.toBe(s));
});

describe("R10-3 время новых шаблонов на враждебных входах ~100 000 символов (§14.5)", () => {
  const inputs: Array<[string, string]> = [
    ["ghp_ + a×100k + _", "ghp_" + "a".repeat(100_000) + "_"],
    ["(*ghp_)×20k", "*ghp_".repeat(20_000)],
    ["(ghp_ + *×36 + пробел)×2.5k", ("ghp_" + "*".repeat(36) + " ").repeat(2_500)],
    ["xoxb- + a×100k + _", "xoxb-" + "a".repeat(100_000) + "_"],
    ["(xoxb-a)×16k + _", "xoxb-a".repeat(16_000) + "_"],
    ["AIza + *×100k", "AIza" + "*".repeat(100_000)],
    ["(AIza + *×35 + a)×2.5k", ("AIza" + "*".repeat(35) + "a").repeat(2_500)],
    ["github_pat_ + a×100k + _", "github_pat_" + "a".repeat(100_000) + "_"],
    ["(*a)×50k после Bearer", "Bearer " + "*a".repeat(50_000)],
    ["sk-* ×25k", "sk-*".repeat(25_000)],
  ];
  for (const [name, s] of inputs)
    it(`${name} < 150 мс`, () => {
      const t0 = performance.now();
      maskSecrets(s, ["abc"]);
      expect(performance.now() - t0).toBeLessThan(150);
    });
});
