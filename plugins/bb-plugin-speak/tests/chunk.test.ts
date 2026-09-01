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
const { MAX_CHUNK_BYTES } = await import("../src/contract");

const bytes = (text: string): number => new TextEncoder().encode(text).length;
const nonSpace = (text: string): string => text.replace(/\s+/gu, "");

test("empty and whitespace-only input produce no chunks", () => {
  assert.deepEqual(chunkForSynthesis(""), []);
  assert.deepEqual(chunkForSynthesis("   \n\n\t  "), []);
});

test("short text stays in one piece", () => {
  assert.deepEqual(chunkForSynthesis("Привет, мир."), ["Привет, мир."]);
});

test("the budget is counted in UTF-8 bytes, not characters", () => {
  // Cyrillic is two bytes a letter: a paragraph well under MAX_CHUNK_BYTES
  // characters is well over it in bytes, which is the mistake being guarded.
  const sentence = "Съешь ещё этих мягких французских булок да выпей чаю. ";
  // Fewer characters than the budget, but far more bytes: counting `.length`
  // would send this to Google as one request and get a 400 back.
  const paragraph = sentence.repeat(70);
  assert.ok(paragraph.length < MAX_CHUNK_BYTES, `${paragraph.length} characters`);
  assert.ok(bytes(paragraph) > MAX_CHUNK_BYTES, `${bytes(paragraph)} bytes`);

  const chunks = chunkForSynthesis(paragraph);
  assert.ok(chunks.length >= 2, `expected several chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(
      bytes(chunk) <= MAX_CHUNK_BYTES,
      `chunk of ${bytes(chunk)} bytes exceeds ${MAX_CHUNK_BYTES}`,
    );
  }

  const long = sentence.repeat(400);
  for (const chunk of chunkForSynthesis(long)) {
    assert.ok(bytes(chunk) <= MAX_CHUNK_BYTES, `chunk of ${bytes(chunk)} bytes`);
  }
  assert.equal(nonSpace(chunkForSynthesis(long).join("")), nonSpace(long));
});

test("a paragraph break is preferred over a sentence end", () => {
  const text = `${"a".repeat(40)}. ${"b".repeat(40)}\n\n${"c".repeat(40)}. ${"d".repeat(40)}`;
  const chunks = chunkForSynthesis(text, 100);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0]!.endsWith("b".repeat(40)), chunks[0]);
  assert.ok(chunks[1]!.startsWith("c".repeat(40)), chunks[1]);
});

test("a sentence end is preferred over a word boundary", () => {
  const text = `${"a".repeat(60)}. ${"b".repeat(60)}`;
  const chunks = chunkForSynthesis(text, 100);
  assert.deepEqual(chunks, [`${"a".repeat(60)}.`, "b".repeat(60)]);
});

test("a closing quote after the stop stays with the sentence it closes", () => {
  const text = `${"а".repeat(20)}, сказал он.» ${"б".repeat(40)}`;
  const chunks = chunkForSynthesis(text, 80);
  assert.ok(chunks[0]!.endsWith(".»"), chunks[0]);
  assert.ok(chunks[1]!.startsWith("б"), chunks[1]);
});

test("a word boundary is used when there is no sentence to end", () => {
  const text = `${"a".repeat(60)} ${"b".repeat(60)}`;
  const chunks = chunkForSynthesis(text, 100);
  assert.deepEqual(chunks, ["a".repeat(60), "b".repeat(60)]);
});

test("a line break is used when the line has no spaces", () => {
  const text = `${"a".repeat(60)}\n${"b".repeat(60)}`;
  const chunks = chunkForSynthesis(text, 100);
  assert.deepEqual(chunks, ["a".repeat(60), "b".repeat(60)]);
});

test("a single word longer than the budget is still emitted", () => {
  const word = "x".repeat(250);
  const chunks = chunkForSynthesis(word, 100);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.join(""), word);
  for (const chunk of chunks) assert.ok(bytes(chunk) <= 100);
});

test("an over-long word does not lose the text around it", () => {
  const text = `начало ${"я".repeat(400)} конец`;
  const chunks = chunkForSynthesis(text, 100);
  for (const chunk of chunks) assert.ok(bytes(chunk) <= 100);
  assert.equal(nonSpace(chunks.join("")), nonSpace(text));
});

test("no chunk is empty or whitespace-only", () => {
  const text = "Раз.\n\n\n\n   \n\nДва.   \t\n\nТри! ".repeat(80);
  for (const chunk of chunkForSynthesis(text, 120)) {
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
  const chunks = chunkForSynthesis(text, 90);
  for (const chunk of chunks) assert.ok(bytes(chunk) <= 90);
  assert.equal(nonSpace(chunks.join("")), nonSpace(text));
});
