import { registerHooks } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * The sources use extension-ful `.js` specifiers, which is what the plugin's
 * esbuild bundler expects; Node's type stripping does not rewrite them, and
 * this tsconfig does not allow writing `.ts` in an import. So teach this
 * process to fall back to the TypeScript sibling, then load the module under
 * test dynamically — the hook has to be in place before the graph is linked.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".")) {
        const candidate = specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : `${specifier}.ts`;
        return nextResolve(candidate, context);
      }
      throw error;
    }
  },
});

const { chunkForSynthesis } = await import("../src/chunk");
const { CHUNK_CHARS, FIRST_CHUNK_CHARS } = await import("../src/contract");

const nonSpace = (text: string): string => text.replace(/\s+/gu, "");

test("empty and whitespace-only input produce no chunks", () => {
  assert.deepEqual(chunkForSynthesis(""), []);
  assert.deepEqual(chunkForSynthesis("   \n\n\t  "), []);
});

test("short text stays in one piece", () => {
  assert.deepEqual(chunkForSynthesis("Привет, мир."), ["Привет, мир."]);
});

test("the first chunk obeys the smaller budget and the later ones the larger", () => {
  const sentence = "Съешь ещё этих мягких французских булок да выпей чаю. ";
  const text = sentence.repeat(60);
  assert.ok(text.length > FIRST_CHUNK_CHARS + CHUNK_CHARS * 3, `${text.length} characters`);

  const chunks = chunkForSynthesis(text);
  assert.ok(chunks.length >= 4, `expected several chunks, got ${chunks.length}`);
  assert.ok(
    chunks[0]!.length <= FIRST_CHUNK_CHARS,
    `first chunk is ${chunks[0]!.length} characters, over ${FIRST_CHUNK_CHARS}`,
  );
  for (const chunk of chunks.slice(1)) {
    assert.ok(chunk.length <= CHUNK_CHARS, `chunk of ${chunk.length} characters over ${CHUNK_CHARS}`);
  }
  // The later chunks really do use the bigger budget rather than the small one.
  assert.ok(
    chunks.slice(1).some((chunk) => chunk.length > FIRST_CHUNK_CHARS),
    "no chunk after the first exceeded the first chunk's budget",
  );
});

test("the budget is characters, not UTF-8 bytes", () => {
  // Cyrillic is two bytes a letter. Under the old byte budget this text would
  // have been cut twice as often; nothing here may measure the encoding.
  const text = "я".repeat(FIRST_CHUNK_CHARS);
  assert.deepEqual(chunkForSynthesis(text), [text]);
  assert.ok(new TextEncoder().encode(text).length > FIRST_CHUNK_CHARS);
});

test("the split is deterministic: same input, same output, twice", () => {
  const text = [
    "Первый абзац с длинным предложением, которое надо разрезать. И ещё одно!",
    "",
    "Второй абзац — с тире, «кавычками» и многоточием… Вот так.",
    `И слово-переросток: ${"ю".repeat(300)}`,
  ].join("\n").repeat(4);
  assert.deepEqual(chunkForSynthesis(text), chunkForSynthesis(text));
  assert.deepEqual(
    chunkForSynthesis(text, { first: 90, rest: 140 }),
    chunkForSynthesis(text, { first: 90, rest: 140 }),
  );
});

test("a paragraph break is preferred over a sentence end", () => {
  const text = `${"a".repeat(40)}. ${"b".repeat(40)}\n\n${"c".repeat(40)}. ${"d".repeat(40)}`;
  const chunks = chunkForSynthesis(text, { first: 100, rest: 100 });
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0]!.endsWith("b".repeat(40)), chunks[0]);
  assert.ok(chunks[1]!.startsWith("c".repeat(40)), chunks[1]);
});

test("a sentence end is preferred over a word boundary", () => {
  const text = `${"a".repeat(60)}. ${"b".repeat(60)}`;
  const chunks = chunkForSynthesis(text, { first: 100, rest: 100 });
  assert.deepEqual(chunks, [`${"a".repeat(60)}.`, "b".repeat(60)]);
});

test("a closing quote after the stop stays with the sentence it closes", () => {
  const text = `${"а".repeat(20)}, сказал он.» ${"б".repeat(40)}`;
  const chunks = chunkForSynthesis(text, { first: 40, rest: 40 });
  assert.ok(chunks[0]!.endsWith(".»"), chunks[0]);
  assert.ok(chunks[1]!.startsWith("б"), chunks[1]);
});

test("a word boundary is used when there is no sentence to end", () => {
  const text = `${"a".repeat(60)} ${"b".repeat(60)}`;
  const chunks = chunkForSynthesis(text, { first: 100, rest: 100 });
  assert.deepEqual(chunks, ["a".repeat(60), "b".repeat(60)]);
});

test("a line break is used when the line has no spaces", () => {
  const text = `${"a".repeat(60)}\n${"b".repeat(60)}`;
  const chunks = chunkForSynthesis(text, { first: 100, rest: 100 });
  assert.deepEqual(chunks, ["a".repeat(60), "b".repeat(60)]);
});

test("a single word longer than the budget is still emitted", () => {
  const word = "x".repeat(250);
  const chunks = chunkForSynthesis(word, { first: 100, rest: 100 });
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.join(""), word);
  for (const chunk of chunks) assert.ok(chunk.length <= 100);
});

test("an over-long word does not lose the text around it", () => {
  const text = `начало ${"я".repeat(400)} конец`;
  const chunks = chunkForSynthesis(text, { first: 100, rest: 100 });
  for (const chunk of chunks) assert.ok(chunk.length <= 100);
  assert.equal(nonSpace(chunks.join("")), nonSpace(text));
});

test("no chunk is empty or whitespace-only", () => {
  const text = "Раз.\n\n\n\n   \n\nДва.   \t\n\nТри! ".repeat(80);
  for (const chunk of chunkForSynthesis(text, { first: 60, rest: 120 })) {
    assert.notEqual(chunk.trim(), "");
    assert.equal(chunk, chunk.trim());
  }
});

test("joining the chunks preserves every non-whitespace character", () => {
  const text = [
    "Первый абзац с длинным предложением, которое надо разрезать. И ещё одно!",
    "",
    "Второй абзац — с тире, «кавычками» и многоточием… Вот так.",
    "",
    `И слово-переросток: ${"ю".repeat(300)}`,
  ].join("\n");
  const chunks = chunkForSynthesis(text, { first: 50, rest: 90 });
  assert.ok(chunks[0]!.length <= 50);
  for (const chunk of chunks.slice(1)) assert.ok(chunk.length <= 90);
  assert.equal(nonSpace(chunks.join("")), nonSpace(text));
});

test("the defaults come from the contract", () => {
  const text = "слово ".repeat(400);
  assert.deepEqual(
    chunkForSynthesis(text),
    chunkForSynthesis(text, { first: FIRST_CHUNK_CHARS, rest: CHUNK_CHARS }),
  );
});
