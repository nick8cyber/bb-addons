import { describe, expect, it } from "vitest";

import { plural, pluralize } from "./plural.js";

describe("plural", () => {
  it("согласует единственное число", () => {
    for (const count of [1, 21, 101, 131]) {
      expect(plural(count, "строка", "строки", "строк")).toBe("строка");
    }
  });

  it("согласует малое количество", () => {
    for (const count of [2, 3, 4, 22, 104]) {
      expect(plural(count, "строка", "строки", "строк")).toBe("строки");
    }
  });

  it("согласует множественное число", () => {
    for (const count of [0, 5, 9, 10, 11, 14, 19, 25, 100, 111]) {
      expect(plural(count, "строка", "строки", "строк")).toBe("строк");
    }
  });
});

describe("pluralize", () => {
  it("склеивает число со словом", () => {
    expect(pluralize(1, "подпись", "подписи", "подписей")).toBe("1 подпись");
    expect(pluralize(2, "подпись", "подписи", "подписей")).toBe("2 подписи");
    expect(pluralize(21, "подпись", "подписи", "подписей")).toBe("21 подпись");
    expect(pluralize(58, "подпись", "подписи", "подписей")).toBe("58 подписей");
  });
});
