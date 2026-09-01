import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { MAX_SPEAKABLE_CHARS } = await import("../src/contract.js");
const { detectLanguage, toSpeakable } = await import("../src/speakable.js");

describe("detectLanguage", () => {
  it("detects en-US when input has only Latin letters", () => {
    assert.equal(detectLanguage("Hello world! This is a test."), "en-US");
  });

  it("detects ru-RU when input has only Cyrillic letters", () => {
    assert.equal(detectLanguage("Привет мир! Это тестовое сообщение."), "ru-RU");
  });

  it("detects en-US when input has no Cyrillic letters at all (empty or symbols)", () => {
    assert.equal(detectLanguage(""), "en-US");
    assert.equal(detectLanguage("1234567890 !@#$%^&*()"), "en-US");
    assert.equal(detectLanguage("    \n\t  "), "en-US");
  });

  it("picks Cyrillic on a tie if there is at least one Cyrillic letter", () => {
    // 2 Cyrillic ('Да') vs 2 Latin ('no')
    assert.equal(detectLanguage("Да no"), "ru-RU");
  });

  it("picks language with majority letter count", () => {
    // 6 Cyrillic ('Привет') vs 5 Latin ('world')
    assert.equal(detectLanguage("Привет world"), "ru-RU");
    // 5 Latin ('Hello') vs 2 Cyrillic ('да')
    assert.equal(detectLanguage("Hello да"), "en-US");
  });
});

describe("toSpeakable", () => {
  it("handles empty and whitespace-only inputs", () => {
    assert.equal(toSpeakable(""), "");
    assert.equal(toSpeakable("   \n\t  \n  "), "");
  });

  it("produces empty string for a message that is nothing but a code block", () => {
    assert.equal(
      toSpeakable("```typescript\nconsole.log('only code block');\n```"),
      "",
    );
    assert.equal(
      toSpeakable("~~~bash\necho 'hello world'\n~~~"),
      "",
    );
    assert.equal(
      toSpeakable("    const x = 10;\n    const y = 20;"),
      "",
    );
  });

  it("removes fenced and indented code blocks leaving sentence breaks", () => {
    const input = `Here is some setup code:

\`\`\`python
def add(a, b):
    return a + b
\`\`\`

Now you can call the function.

    x = add(1, 2)
    print(x)

Done!`;

    const expected = `Here is some setup code:\n\nNow you can call the function.\n\nDone!`;
    assert.equal(toSpeakable(input), expected);
  });

  it("strips backticks from inline code keeping the identifier content", () => {
    const input = "Check `src/speakable.ts` and call `toSpeakable(text)`. Also ``code with ` backtick``.";
    const expected = "Check src/speakable.ts and call toSpeakable(text). Also code with ` backtick.";
    assert.equal(toSpeakable(input), expected);
  });

  it("strips images entirely including alt text", () => {
    const input = "Here is a picture: ![A cute puppy](https://example.com/puppy.jpg). Isn't it great?";
    const expected = "Here is a picture:. Isn't it great?";
    assert.equal(toSpeakable(input), expected);
  });

  it("replaces links with labels and strips definition lines, autolinks, and bare URLs", () => {
    const input = `Visit [our website](https://example.com) or [the docs][doc-ref].
Autolinks like <https://getbb.dev> or <mailto:test@example.com> and bare https://github.com/get-bb are noise.

[doc-ref]: https://example.com/docs "Documentation"`;

    const expected = `Visit our website or the docs.\nAutolinks like or and bare are noise.`;
    assert.equal(toSpeakable(input), expected);
  });

  it("converts ATX and Setext headings with appended full stop for speech pauses", () => {
    const input = `# Main Heading
Some text.

Setext Heading 1
================

Setext Heading 2
----------------

### Sub Heading ###

#### Heading with Question?`;

    const expected = `Main Heading.\nSome text.\n\nSetext Heading 1.\n\nSetext Heading 2.\n\nSub Heading.\n\nHeading with Question?`;
    assert.equal(toSpeakable(input), expected);
  });

  it("strips list markers, task boxes, and blockquotes, ensuring terminal punctuation", () => {
    const input = `> Important note here
> Second quote line.

- [ ] First task item
- [x] Second task completed!
* Third item without period
+ Fourth item with question?
1. First numbered step
2) Second numbered step`;

    const expected = `Important note here.\nSecond quote line.\n\nFirst task item.\nSecond task completed!\nThird item without period.\nFourth item with question?\nFirst numbered step.\nSecond numbered step.`;
    assert.equal(toSpeakable(input), expected);
  });

  it("removes table rows and pipe separators completely", () => {
    const input = `Before table.

| Feature | Supported | Notes |
| :------ | :-------: | ----: |
| Voice   |    Yes    | High  |
| Video   |    No     | N/A   |

After table.

Col 1 | Col 2
---|---
Val 1 | Val 2

End of message.`;

    const expected = `Before table.\n\nAfter table.\n\nEnd of message.`;
    assert.equal(toSpeakable(input), expected);
  });

  it("strips emphasis while keeping intra-word underscores intact", () => {
    const input = "Use **bold text**, *italic text*, __underline bold__, _underline italic_, and ~~strikethrough~~. Notice `some_var_name` and other_var_name stay intact.";
    const expected = "Use bold text, italic text, underline bold, underline italic, and strikethrough. Notice some_var_name and other_var_name stay intact.";
    assert.equal(toSpeakable(input), expected);
  });

  it("strips raw HTML tags, turns <br> into line breaks, and decodes HTML entities", () => {
    const input = "Paragraph with <b>bold</b> and <span class=\"highlight\">span text</span>.<br>Next line &amp; &lt;tag&gt; &quot;quoted&#39; &nbsp; &mdash; &ndash; &hellip; &#65;";
    const expected = "Paragraph with bold and span text.\nNext line & <tag> \"quoted' — – … A";
    assert.equal(toSpeakable(input), expected);
  });

  it("removes thematic breaks on their own lines", () => {
    const input = `Paragraph one.

---

Paragraph two.

***

Paragraph three.

___

Paragraph four.`;

    const expected = `Paragraph one.\n\nParagraph two.\n\nParagraph three.\n\nParagraph four.`;
    assert.equal(toSpeakable(input), expected);
  });

  it("removes footnote references and definitions", () => {
    const input = `This statement needs citation[^1] and another[^2].

[^1]: First footnote content.
[^2]: Second footnote content.`;

    const expected = "This statement needs citation and another.";
    assert.equal(toSpeakable(input), expected);
  });

  it("removes emoji and pictographs while preserving typographic punctuation and dashes", () => {
    const input = "Hello 👋 world 🚀! Great job 👍🏽 on this task 🎉. «Typographic quotes» — em-dash – en-dash and ellipsis…";
    const expected = "Hello world! Great job on this task. «Typographic quotes» — em-dash – en-dash and ellipsis…";
    assert.equal(toSpeakable(input), expected);
  });

  it("collapses runs of spaces and collapses 3+ newlines to 2", () => {
    const input = "Too     many   spaces   here.\n\n\n\n\nNext    paragraph.";
    const expected = "Too many spaces here.\n\nNext paragraph.";
    assert.equal(toSpeakable(input), expected);
  });

  it("truncates at MAX_SPEAKABLE_CHARS on sentence boundary", () => {
    const sentence = "This is a sentence. ";
    const longText = sentence.repeat(Math.ceil(MAX_SPEAKABLE_CHARS / sentence.length) + 10);
    const result = toSpeakable(longText);

    assert.ok(result.length <= MAX_SPEAKABLE_CHARS);
    assert.ok(result.endsWith("."));
    assert.ok(result.length > MAX_SPEAKABLE_CHARS - sentence.length);
  });

  it("handles a realistic mixed assistant response", () => {
    const mixedInput = `# Overview

Here is how you can resolve the issue:

First, check the [documentation](https://example.com/docs) and update your \`config_var_name\` in \`.env\`.

\`\`\`bash
npm install
npm test
\`\`\`

Key steps to verify:
- [x] Run the build **before** deploying 🚀
- [ ] Check logs at <https://logs.example.com>
- Ensure all tests pass.

| Service | Status |
| ------- | ------ |
| API     | Online |

Done!`;

    const expected = `Overview.

Here is how you can resolve the issue:

First, check the documentation and update your config_var_name in .env.

Key steps to verify:
Run the build before deploying.
Check logs at.
Ensure all tests pass.

Done!`;

    assert.equal(toSpeakable(mixedInput), expected);
  });

  it("converts a heading that itself contains a hash", () => {
    // The heading rule used to refuse any line with a second `#`, which left
    // the markers in for the engine to pronounce as "hash hash".
    assert.equal(toSpeakable("## Issue #23 is closed"), "Issue #23 is closed.");
    assert.equal(toSpeakable("# C# notes"), "C# notes.");
    assert.equal(toSpeakable("## Done ##"), "Done.");
  });

  it("consumes a link URL that carries balanced parentheses", () => {
    // Stopping at the first `)` left the second one stranded in the prose.
    assert.equal(toSpeakable("see [docs](https://ex.com/a_(b)) now"), "see docs now");
    assert.equal(toSpeakable("![shot](https://ex.com/a_(b)) gone"), "gone");
  });
});
