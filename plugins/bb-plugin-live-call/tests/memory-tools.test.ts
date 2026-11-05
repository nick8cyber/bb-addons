/** 03.11: на «что у тебя в памяти» голос выдал правила агентов-кодеров из общей памяти BB за свою память. */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      child.stderr.emit("data", "customAcpAgents in config.json is no longer read.");
      child.stdout.emit("data", "always-commit-finished-work\n  Законченную работу коммитить самому");
      child.emit("close", 0);
    }, 0);
    return child;
  },
}));

const { OWN_MEMORY_SOURCE, SHARED_KB_SOURCE, capabilityList, nativeDeclarations, readActionLabel, toolByName } = await import("../src/tools.js");
const { routerInstruction, voiceInstructionNormal } = await import("../src/prompt.js");

const ctx = (items: string[]) =>
  ({ voiceMemory: { add: () => ({ id: 1, duplicate: false }), list: () => items.map((text, id) => ({ id, text })) } }) as never;

describe("своя память звонков и общая база знаний BB", () => {
  it("recall отдаёт только память звонков с меткой источника", async () => {
    const r = await toolByName("recall")!.execute({}, ctx(["Называть треды по названию"]));
    expect(r.ok).toBe(true);
    expect((r as { data: unknown }).data).toEqual({ source: OWN_MEMORY_SOURCE, count: 1, items: ["Называть треды по названию"] });
  });

  it("search_memory: метка «ОБЩАЯ база знаний BB» первой, предупреждения CLI не попадают", async () => {
    const r = await toolByName("search_memory")!.execute({ query: "всё" }, ctx([]));
    expect(r.ok).toBe(true);
    const text = JSON.stringify((r as { data: unknown }).data);
    expect(text.indexOf(SHARED_KB_SOURCE)).toBe(text.indexOf('"source"') + '"source":"'.length);
    expect(text).toContain("коммитить самому");
    expect(text).not.toContain("customAcpAgents");
  });

  it("карточка не называет общую базу «памятью», recall объявлен и в умениях", () => {
    expect(readActionLabel("search_memory", { query: "всё" })!.done).toBe("Искал в базе знаний BB «всё»");
    expect(readActionLabel("recall", {})!.running).toBe("Смотрю свою память звонков");
    expect(JSON.stringify(nativeDeclarations())).toContain('"recall"');
    expect(capabilityList().read.join(" ")).toContain("моя память звонков");
  });

  it("инструкции: на вопрос о памяти — recall, а не search_memory", () => {
    expect(routerInstruction()).toMatch(/что у тебя в памяти.*recall.*НЕ search_memory/);
    expect(voiceInstructionNormal()).toContain("инструмент recall");
    expect(voiceInstructionNormal()).toContain("ОБЩАЯ база знаний BB");
  });
});
