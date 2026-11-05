import { describe, expect, it } from "vitest";
import { normalizeTitle, readActionLabel } from "../src/tools.js";

describe("подписи карточек и имена тредов", () => {
  it("read_thread — что делаю, а не описание инструмента", () => {
    const l = readActionLabel("read_thread", { thread: "Проект A: фоллбэк" })!;
    expect(l.running).toBe("Читаю «Проект A: фоллбэк»");
    expect(l.running).not.toMatch(/усечение|символов/);
  });
  it("инструменты записи карточку здесь не получают", () => {
    expect(readActionLabel("send_to_thread", {})).toBeNull();
  });
  it("имя из речи совпадает с названием без кавычек, регистра и ё", () => {
    expect(normalizeTitle("«Разработка плагина для Real-Time voice диалога»")).toBe(normalizeTitle("разработка плагина для real-time voice диалога"));
    expect(normalizeTitle("Ёлка, тест!")).toBe("елка тест");
  });
});
