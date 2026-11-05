/** Фильтр эха: реплика владельца, совпадающая с речью агента, отбрасывается. */
import { describe, expect, it } from "vitest";
import { isEcho } from "../src/call-session.js";

describe("isEcho", () => {
  const agent = "Связь отличная, вас слышно замечательно. Чем я могу вам помочь?";

  it("эхо той же фразы — эхо", () => {
    expect(isEcho("связь отличная, вас слышно замечательно", agent)).toBe(true);
  });
  it("эхо с искажением распознавания — всё ещё эхо", () => {
    expect(isEcho("связь отличная, вас слышно замечательно, чем могу помочь", agent)).toBe(true);
  });
  it("другая короткая реплика владельца — не эхо", () => {
    expect(isEcho("сколько проектов в bb", agent)).toBe(false);
  });
  it("вопрос про дату — не эхо", () => {
    expect(isEcho("какая сейчас дата и время на сервере", agent)).toBe(false);
  });
  it("пустые строки — не эхо", () => {
    expect(isEcho("", agent)).toBe(false);
    expect(isEcho("тест", "")).toBe(false);
  });
});
