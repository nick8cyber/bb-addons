/** Негативные и позитивные тесты классификатора — приёмка Ф3 (спека §9). */
import { describe, expect, it } from "vitest";
import { classify, DEFAULT_WORDS, normalizeUtterance } from "../src/classify.js";

const words = DEFAULT_WORDS;

describe("normalizeUtterance", () => {
  it("убирает пунктуацию, приводит ё→е, нижний регистр", () => {
    expect(normalizeUtterance("Да, запускай!")).toEqual(["да", "запускай"]);
    expect(normalizeUtterance("Ну, пожалуйста")).toEqual(["ну", "пожалуйста"]);
  });
});

describe("класс L (запуск): только явный глагол команды", () => {
  it("«запускай» — approved", () => {
    expect(classify("запускай", "L", words)).toBe("approved");
  });
  it("«запусти» и «раздай» — approved", () => {
    expect(classify("запусти", "L", words)).toBe("approved");
    expect(classify("раздай", "L", words)).toBe("approved");
  });
  it("«да, запускай» и «давай, раздай» — approved (довесок класса C)", () => {
    expect(classify("да, запускай", "L", words)).toBe("approved");
    expect(classify("давай, раздай", "L", words)).toBe("approved");
  });
  it("одиночное «да» — НЕ запуск: hint", () => {
    expect(classify("да", "L", words)).toBe("hint");
  });
  it("«хорошо», «согласен» — не запуск: отмена (согласие с планом, не команда)", () => {
    expect(classify("хорошо", "L", words)).toBe("cancelled");
    expect(classify("согласен", "L", words)).toBe("cancelled");
  });
  it("«да, сначала проект A» — отмена (остаток после разрешённых слов)", () => {
    expect(classify("да, сначала проект A", "L", words)).toBe("cancelled");
  });
});

describe("класс P (разрешение агенту): только «разрешаю»", () => {
  it("«разрешаю» — approved", () => {
    expect(classify("разрешаю", "P", words)).toBe("approved");
  });
  it("«да, разрешаю» — approved", () => {
    expect(classify("да, разрешаю", "P", words)).toBe("approved");
  });
  it("просто «да» — hint", () => {
    expect(classify("да", "P", words)).toBe("hint");
  });
});

describe("класс C (подтверждение)", () => {
  it("«да», «ок», «отправляй» — approved", () => {
    expect(classify("да", "C", words)).toBe("approved");
    expect(classify("ок", "C", words)).toBe("approved");
    expect(classify("отправляй", "C", words)).toBe("approved");
  });
  it("«останавливай» — approved для stop_thread (toolExtra)", () => {
    expect(classify("останавливай", "C", { ...words, toolExtra: ["останавливай"] })).toBe("approved");
  });
  it("«наверное» — отмена", () => {
    expect(classify("наверное", "C", words)).toBe("cancelled");
  });
  it("«да, но сначала…» — отмена: «но» слово отказа", () => {
    expect(classify("да, но сначала проверь", "C", words)).toBe("cancelled");
  });
});

describe("отказ сильнее согласия", () => {
  it("«нет» — отмена во всех классах", () => {
    expect(classify("нет", "C", words)).toBe("cancelled");
    expect(classify("нет", "L", words)).toBe("cancelled");
    expect(classify("нет", "P", words)).toBe("cancelled");
  });
  it("«стоп», «отмена», «подожди» — отмена", () => {
    for (const w of ["стоп", "отмена", "подожди"]) {
      expect(classify(w, "L", words)).toBe("cancelled");
    }
  });
  it("«да, нет» — отмена: отказ перевешивает", () => {
    expect(classify("да нет", "C", words)).toBe("cancelled");
  });
});

describe("неоднозначное и шум", () => {
  it("пусто и шум — отмена", () => {
    expect(classify("", "C", words)).toBe("cancelled");
    expect(classify("??? ...", "C", words)).toBe("cancelled");
  });
  it("длиннее 6 слов — отмена", () => {
    expect(classify("да давай ну пожалуйста уже конечно сделай", "L", words)).toBe("cancelled");
  });
  it("нераспознанное — отмена", () => {
    expect(classify("привет как дела", "C", words)).toBe("cancelled");
  });
});

describe("латиница распознавания", () => {
  it("«da» = «да»: для отправки — approved, для запуска — подсказка, не запуск", () => {
    expect(classify("da", "C", DEFAULT_WORDS)).toBe("approved");
    expect(classify("da", "L", DEFAULT_WORDS)).toBe("hint");
  });
  it("«net» — отмена, «zapuskay» — запуск", () => {
    expect(classify("net", "C", DEFAULT_WORDS)).toBe("cancelled");
    expect(classify("zapuskay", "L", DEFAULT_WORDS)).toBe("approved");
  });
});
