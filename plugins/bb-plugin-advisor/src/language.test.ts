import { describe, expect, it } from "vitest";

import {
  needsRussianTranslation,
  prepareRussianTranslation,
  russianReviewInstruction,
  withTranslationFailureNotice,
  type ReviewText,
} from "./language.js";

const NOTICE = "Не удалось перевести ревью на русский; показан оригинал";
const PLACEHOLDER = /\[\[ADVISOR_[^\]]*\]\]/g;

function protectedPayload(prompt: string): ReviewText {
  const line = prompt.trimEnd().split("\n").at(-1) ?? "";
  return JSON.parse(line) as ReviewText;
}

function tokensIn(text: string): string[] {
  return text.match(PLACEHOLDER) ?? [];
}

describe("russian review instruction", () => {
  it("keeps the machine-readable advisor contract explicit", () => {
    const instruction = russianReviewInstruction();
    for (const literal of [
      "severity",
      "key",
      "summary",
      "details",
      "resolved",
      "pass|nit|concern|blocker",
      "Latin",
      "none",
      "ADVISOR_RESULT",
      "END_ADVISOR_RESULT",
    ]) {
      expect(instruction).toContain(literal);
    }
    expect(instruction).toContain("по-русски");
  });

  it("does not forbid findings, severities or resolved keys", () => {
    const instruction = russianReviewInstruction();
    expect(instruction).not.toContain("не закрывай");
    expect(instruction).not.toContain("не добавляй");
    expect(instruction).not.toContain("не меняй оценку");
    expect(instruction).toContain("для повторной — прежний key");
    expect(instruction).toContain("resolved");
  });
});

describe("russian translation gate", () => {
  it("accepts russian prose with allowed technical words", () => {
    expect(
      needsRussianTranslation({
        summary: "Исправлен timeout при retry",
        details: "none",
      }),
    ).toBe(false);
  });

  it("accepts an empty details field and a literal none", () => {
    expect(needsRussianTranslation({ summary: "Проверено", details: "" })).toBe(
      false,
    );
    expect(
      needsRussianTranslation({ summary: "Проверено", details: "none" }),
    ).toBe(false);
    expect(
      needsRussianTranslation({ summary: "Проверено", details: "- none." }),
    ).toBe(false);
  });

  it("requires translation for english prose", () => {
    expect(
      needsRussianTranslation({
        summary: "The migration is not atomic",
        details: "none",
      }),
    ).toBe(true);
  });

  it("requires translation for a mixed field", () => {
    expect(
      needsRussianTranslation({
        summary: "Исправлено. The function returns before state is saved",
        details: "none",
      }),
    ).toBe(true);
  });

  it("checks summary and details separately", () => {
    expect(
      needsRussianTranslation({
        summary: "Проверено",
        details: "The function returns before state is saved",
      }),
    ).toBe(true);
    expect(
      needsRussianTranslation({
        summary: "The function returns before state is saved",
        details: "Проверено",
      }),
    ).toBe(true);
  });

  it("rejects a single cyrillic word amid english prose", () => {
    expect(
      needsRussianTranslation({
        summary: "The function returns да before state is saved",
        details: "none",
      }),
    ).toBe(true);
    expect(
      needsRussianTranslation({ summary: "The function returns да", details: "none" }),
    ).toBe(true);
  });

  it("accepts pure technical content", () => {
    expect(
      needsRussianTranslation({
        summary: "timeout retry cache API SDK JSON HTTP",
        details: "none",
      }),
    ).toBe(false);
    expect(
      needsRussianTranslation({
        summary:
          "AdvisorFinding getUserById snake_case_name kebab-case-name MAX_SIZE",
        details: "none",
      }),
    ).toBe(false);
  });

  it("accepts russian prose containing identifiers", () => {
    expect(
      needsRussianTranslation({
        summary: "Исправлен парсинг AdvisorFinding в state",
        details: "none",
      }),
    ).toBe(false);
  });

  it("ignores protected code, URLs, paths, quotes and numbers", () => {
    for (const summary of [
      "`npm run verify`",
      "https://example.com/foo/bar?x=1",
      "src/language.ts:42",
      "C:\\work\\tree\\language.ts",
      '"The function returns before state is saved"',
      "“The function returns before state is saved”",
      "«The function returns before state is saved»",
      "> The function returns before state is saved",
      "3.14 1.2.3 12:30 v2.0.1",
      "```ts\nthe function returns before state is saved\n```",
    ]) {
      expect(needsRussianTranslation({ summary, details: "none" })).toBe(false);
    }
  });

  it("treats single quotes and apostrophes as prose", () => {
    expect(
      needsRussianTranslation({
        summary: "'The function returns before state is saved'",
        details: "none",
      }),
    ).toBe(true);
    expect(needsRussianTranslation({ summary: "don't", details: "none" })).toBe(
      true,
    );
    expect(needsRussianTranslation({ summary: "it's", details: "none" })).toBe(
      true,
    );
  });

  it("applies the sixty percent cyrillic boundary", () => {
    expect(
      needsRussianTranslation({ summary: "абвгде test", details: "none" }),
    ).toBe(false);
    expect(
      needsRussianTranslation({ summary: "абвгд test", details: "none" }),
    ).toBe(true);
  });

  it("rejects a long english run even with mostly cyrillic prose", () => {
    expect(
      needsRussianTranslation({
        summary:
          "Это очень длинное и подробное описание русской проблемы, которое содержит много слов: the function returns before",
        details: "none",
      }),
    ).toBe(true);
  });
});

describe("russian translation round trip", () => {
  it("preserves protected fragments byte-for-byte", () => {
    const review: ReviewText = {
      summary:
        'Проверь `runReview()` в src/language.ts:42 и https://example.com/a?b=1',
      details:
        'Цитата "the retry", версия 1.2.3, файл C:\\work\\tree\\x.ts',
    };
    const { prompt, parse } = prepareRussianTranslation(review);
    const payload = protectedPayload(prompt);

    expect(tokensIn(payload.summary)).toHaveLength(3);
    expect(tokensIn(payload.details)).toHaveLength(3);
    expect(parse(JSON.stringify(payload))).toEqual(review);
  });

  it("translates english prose around protected placeholders", () => {
    const review: ReviewText = {
      summary: "Check `runReview()` before saving",
      details: "The function returns early.",
    };
    const { prompt, parse } = prepareRussianTranslation(review);
    const payload = protectedPayload(prompt);
    const [token] = tokensIn(payload.summary);

    const output = JSON.stringify({
      summary: `Проверь ${token} перед сохранением`,
      details: "Функция завершается раньше времени.",
    });

    expect(parse(output)).toEqual({
      summary: "Проверь `runReview()` перед сохранением",
      details: "Функция завершается раньше времени.",
    });
  });

  it("uses a distinct token for each repeated fragment", () => {
    const review: ReviewText = { summary: "Проверь `x` и `x`", details: "none" };
    const { prompt, parse } = prepareRussianTranslation(review);
    const payload = protectedPayload(prompt);
    const [first, second] = tokensIn(payload.summary);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    expect(parse(JSON.stringify(payload))).toEqual(review);
  });
});

describe("russian translation rejection", () => {
  const review: ReviewText = {
    summary: "Проверь `runReview()` в src/language.ts",
    details: "Исправлено",
  };

  function prepared() {
    const { prompt, parse } = prepareRussianTranslation(review);
    return { payload: protectedPayload(prompt), parse };
  }

  it("rejects malformed json", () => {
    const { parse } = prepared();
    expect(parse("not json")).toBeNull();
    expect(parse('{"summary":"Проверено","details":"none",}')).toBeNull();
  });

  it("rejects non-string or missing fields", () => {
    const { parse } = prepared();
    expect(parse(JSON.stringify({ summary: 1, details: "none" }))).toBeNull();
    expect(parse(JSON.stringify({ summary: "Проверено" }))).toBeNull();
    expect(parse(JSON.stringify(["Проверено", "none"]))).toBeNull();
  });

  it("rejects extra severity, key and resolved fields", () => {
    const { parse } = prepared();
    for (const extra of [
      { severity: "blocker" },
      { key: "some-key" },
      { resolved: "some-key" },
    ]) {
      expect(
        parse(
          JSON.stringify({
            summary: "Проверено",
            details: "none",
            ...extra,
          }),
        ),
      ).toBeNull();
    }
  });

  it("rejects oversized json", () => {
    const { parse } = prepared();
    const output = JSON.stringify({
      summary: "Проверено",
      details: "x".repeat(256 * 1024),
    });
    expect(parse(output)).toBeNull();
  });

  it("rejects a lost, duplicated or moved token", () => {
    const { payload, parse } = prepared();
    const [token] = tokensIn(payload.summary);

    expect(
      parse(JSON.stringify({ summary: "Проверено без кода", details: "none" })),
    ).toBeNull();
    expect(
      parse(
        JSON.stringify({
          summary: `Проверено ${token} и ${token}`,
          details: "none",
        }),
      ),
    ).toBeNull();
    expect(
      parse(
        JSON.stringify({
          summary: "Проверено",
          details: `Исправлено ${token}`,
        }),
      ),
    ).toBeNull();
  });

  it("rejects an unknown or colliding token", () => {
    const { payload, parse } = prepared();
    const [token] = tokensIn(payload.summary);

    expect(
      parse(
        JSON.stringify({
          summary: `Проверено ${token} [[ADVISOR_FAKE]]`,
          details: "none",
        }),
      ),
    ).toBeNull();
  });

  it("rejects newly added code, URLs, paths, quotes and numbers", () => {
    const { payload, parse } = prepared();
    const [token] = tokensIn(payload.summary);

    for (const summary of [
      `Проверь ${token} и выполни \`rm -rf /\``,
      `Проверь ${token} и выполни:\n\`\`\`sh\nrm -rf /\n\`\`\``,
      `Проверь ${token}, см. https://example.com/new`,
      `Проверь ${token}, удали 42 файла`,
      `Проверь ${token}, файл src/language.ts:42`,
      `Проверь ${token}, слово "новое"`,
    ]) {
      expect(parse(JSON.stringify({ summary, details: "Исправлено" }))).toBeNull();
    }
  });

  it("rejects empty, whitespace or none replacements for real prose", () => {
    const { parse } = prepareRussianTranslation({
      summary: "The function returns early.",
      details: "The write occurs before the transaction starts.",
    });

    for (const output of [
      { summary: "", details: "Запись происходит до транзакции." },
      { summary: "   ", details: "Запись происходит до транзакции." },
      { summary: "none", details: "Запись происходит до транзакции." },
      { summary: "Функция возвращается раньше.", details: "" },
      { summary: "Функция возвращается раньше.", details: "  \n\t" },
      { summary: "Функция возвращается раньше.", details: "none" },
      { summary: "", details: "" },
    ]) {
      expect(parse(JSON.stringify(output))).toBeNull();
    }
  });

  it("allows an empty original details field to stay empty or none", () => {
    const { parse } = prepareRussianTranslation({
      summary: "The function returns early.",
      details: "",
    });

    expect(
      parse(
        JSON.stringify({
          summary: "Функция возвращается раньше.",
          details: "",
        }),
      ),
    ).not.toBeNull();
    expect(
      parse(
        JSON.stringify({
          summary: "Функция возвращается раньше.",
          details: "none",
        }),
      ),
    ).not.toBeNull();
  });

  it("keeps summary substantive even when the original summary is empty", () => {
    const { parse } = prepareRussianTranslation({ summary: "", details: "" });
    expect(
      parse(JSON.stringify({ summary: "none", details: "" })),
    ).toBeNull();
  });

  it("rejects a translation that is still english", () => {
    const { parse } = prepareRussianTranslation({
      summary: "The function returns early.",
      details: "none",
    });
    expect(
      parse(
        JSON.stringify({
          summary: "The function returns before state is saved",
          details: "none",
        }),
      ),
    ).toBeNull();
  });

  it("rejects a partially translated field", () => {
    const { parse } = prepareRussianTranslation({
      summary: "The function returns early.",
      details: "none",
    });
    expect(
      parse(
        JSON.stringify({
          summary: "Функция возвращается. The function returns before state is saved",
          details: "none",
        }),
      ),
    ).toBeNull();
  });
});

describe("translation failure notice", () => {
  it("keeps the original text and appends the russian notice", () => {
    const review: ReviewText = {
      summary: "The migration is not atomic",
      details: "The write occurs before the transaction starts.",
    };
    expect(withTranslationFailureNotice(review)).toEqual({
      summary: review.summary,
      details: `${review.details}\n\n${NOTICE}`,
    });
  });

  it("uses only the notice for empty details", () => {
    expect(
      withTranslationFailureNotice({ summary: "The migration is not atomic", details: "" }),
    ).toEqual({ summary: "The migration is not atomic", details: NOTICE });
  });

  it("keeps a literal none and appends the notice", () => {
    expect(
      withTranslationFailureNotice({ summary: "The migration is not atomic", details: "none" }),
    ).toEqual({
      summary: "The migration is not atomic",
      details: `none\n\n${NOTICE}`,
    });
  });
});

describe("protected literal boundary regressions from independent review", () => {
  it.each([".evil", "?redirect=evil", "/extra"])("rejects an appended URL suffix %s", (suffix) => {
    const prepared = prepareRussianTranslation({
      summary: "Check https://example.com before returning.", details: "none",
    });
    const token = tokensIn(protectedPayload(prepared.prompt).summary)[0]!;
    expect(prepared.parse(JSON.stringify({
      summary: "Проверь " + token + suffix + " перед возвратом.", details: "none",
    }))).toBeNull();
  });

  it("protects numbers with units and rejects changing their values", () => {
    const prepared = prepareRussianTranslation({
      summary: "The timeout is 100ms before returning.", details: "none",
    });
    const payload = protectedPayload(prepared.prompt);
    const [token] = tokensIn(payload.summary);
    expect(token).toBeDefined();
    expect(payload.summary).not.toContain("100ms");
    expect(prepared.parse(JSON.stringify({
      summary: "Таймаут составляет " + token + " перед возвратом.", details: "none",
    }))).toEqual({ summary: "Таймаут составляет 100ms перед возвратом.", details: "none" });
    expect(prepared.parse(JSON.stringify({
      summary: "Таймаут составляет 900ms перед возвратом.", details: "none",
    }))).toBeNull();
  });

  it.each(["900ms", "2s", "1e9", "100%", "5сек"])("rejects a newly introduced numeric literal %s", (literal) => {
    const prepared = prepareRussianTranslation({
      summary: "The function returns too early.", details: "none",
    });
    expect(prepared.parse(JSON.stringify({
      summary: "Функция завершается через " + literal + " слишком рано.", details: "none",
    }))).toBeNull();
  });

  it.each([
    "/tmp/данные",
    "C:\\работа\\данные.txt",
    "данные/файл.yaml:42",
    "настройки.yaml",
    "/tmp/и\u0306мя",
  ])("protects the entire Unicode path or filename %s", (path) => {
    const prepared = prepareRussianTranslation({
      summary: "Check " + path + " before returning.", details: "none",
    });
    const payload = protectedPayload(prepared.prompt);
    const [token] = tokensIn(payload.summary);
    expect(token).toBeDefined();
    expect(payload.summary).not.toContain("данные");
    expect(prepared.parse(JSON.stringify({
      summary: "Проверь " + token + " перед возвратом.", details: "none",
    }))).toEqual({ summary: "Проверь " + path + " перед возвратом.", details: "none" });
    expect(prepared.parse(JSON.stringify({
      summary: "Проверь " + token + "/другие перед возвратом.", details: "none",
    }))).toBeNull();
  });

  it("rejects numeric token suffixes that extend the original number", () => {
    const prepared = prepareRussianTranslation({
      summary: "The timeout is 100ms before returning.", details: "none",
    });
    const token = tokensIn(protectedPayload(prepared.prompt).summary)[0]!;
    expect(prepared.parse(JSON.stringify({
      summary: "Таймаут составляет " + token + "extra перед возвратом.", details: "none",
    }))).toBeNull();
  });
});
