/** Негативные и позитивные тесты классификатора — приёмка Ф3 (спека §9). */
import { describe, expect, it } from "vitest";
import { classify, DEFAULT_WORDS, normalizeUtterance } from "../src/classify.js";

const words = DEFAULT_WORDS;

describe("normalizeUtterance", () => {
  it("убирает пунктуацию, приводит ё→е, нижний регистр", () => {
    expect(normalizeUtterance("Да, запускай!")).toEqual(["да", "запускай"]);
    expect(normalizeUtterance("Ну, пожалуйста")).toEqual(["ну", "пожалуйста"]);
  });
  it("дефис между буквами/цифрами разделяет слова в реплике владельца (п. 5), апостроф остаётся", () => {
    expect(normalizeUtterance("агенту-куратору")).toEqual(["агенту", "куратору"]);
    expect(normalizeUtterance("don't run")).toEqual(["don't", "run"]);
    expect(normalizeUtterance("Да-да.")).toEqual(["да", "да"]);
    expect(normalizeUtterance("Нет-нет.")).toEqual(["нет", "нет"]);
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
  it("«разрешаю», «разреши», «одобряю» — approved", () => {
    expect(classify("разрешаю", "P", words)).toBe("approved");
    expect(classify("разреши", "P", words)).toBe("approved");
    expect(classify("одобряю", "P", words)).toBe("approved");
  });
  it("«да, разрешаю» — approved", () => {
    expect(classify("да, разрешаю", "P", words)).toBe("approved");
  });
  it("просто «да» — hint", () => {
    expect(classify("да", "P", words)).toBe("hint");
  });
  it("только вежливые слова для P — cancelled", () => {
    expect(classify("пожалуйста", "P", words)).toBe("cancelled");
    expect(classify("спасибо", "P", words)).toBe("cancelled");
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
  it("дефисные ответы согласия: «Да-да», «Ок-ок» — approved (P2-3)", () => {
    expect(classify("Да-да.", "C", words)).toBe("approved");
    expect(classify("Ок-ок", "C", words)).toBe("approved");
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
  it("дефисные ответы отказа: «Нет-нет», «Не-не» — cancelled (P2-3)", () => {
    expect(classify("Нет-нет.", "C", words)).toBe("cancelled");
    expect(classify("Не-не", "C", words)).toBe("cancelled");
  });
  it("расширенный список слов отказа (§7.1 п. 5.1)", () => {
    for (const w of ["отставить", "отставь", "отказ", "отказываюсь", "нельзя", "неа", "нее", "хватит", "передумал", "передумала"]) {
      expect(classify(w, "C", words)).toBe("cancelled");
    }
  });
  it("латиница отказа: nyet, niet, njet, no, nope, otmena, otmeni, cancel, stoi", () => {
    for (const w of ["nyet", "niet", "njet", "no", "nope", "otmena", "otmeni", "cancel", "stoi"]) {
      expect(classify(w, "C", words)).toBe("cancelled");
    }
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
  it("ответ из нескольких слов латиницей без согласия — cancelled", () => {
    expect(classify("wait a minute please", "C", DEFAULT_WORDS)).toBe("cancelled");
    expect(classify("i do not know", "C", DEFAULT_WORDS)).toBe("cancelled");
  });
});
