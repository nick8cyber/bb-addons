import { describe, expect, it } from "vitest";
import { voiceInstructionExtended, voiceInstructionNormal } from "../src/prompt.js";

const ctx = {
  projects: ["BB", "Проект X"],
  capabilities: { read: ["обзор BB по проектам"], confirm: ["запомнить в свою память"], launch: ["запустить нового агента"] },
  memory: ["Называть треды по названию"],
  mode: "extended" as const,
};

describe("системная инструкция", () => {
  it("знает, кто он, проекты, память и правило «по названию»", () => {
    const t = voiceInstructionNormal(ctx);
    expect(t).toMatch(/голосовой координатор/);
    expect(t).toMatch(/BB, Проект X/);
    expect(t).toMatch(/Называть треды по названию/);
    expect(t).toMatch(/Никогда не читай вслух идентификаторы/);
  });
  it("Extended: голос не получает указаний вызывать инструменты сам (иначе Google «system error»)", () => {
    const t = voiceInstructionExtended(ctx);
    expect(t).not.toMatch(/инструментом remember/);
    expect(t).toMatch(/ты сам ничего не вызываешь/);
    expect(t).toMatch(/запустить нового агента/);
  });
});
