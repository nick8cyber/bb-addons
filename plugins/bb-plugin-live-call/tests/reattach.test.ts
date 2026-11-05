import { describe, expect, it } from "vitest";
import { decideHello } from "../src/reattach.js";

describe("hello: старт, возврат, busy, gone", () => {
  it("нет звонка — новый звонок; resume на завершённый — gone", () => {
    expect(decideHello(null, undefined)).toBe("start");
    expect(decideHello(null, "call_a")).toBe("gone");
  });
  it("звонок ждёт возврата — resume с тем же callId возвращает", () => {
    expect(decideHello({ callId: "call_a", detached: true }, "call_a")).toBe("reattach");
  });
  it("страницу перезагрузили (callId потерян) — hello без resume подхватывает ждущий звонок", () => {
    expect(decideHello({ callId: "call_a", detached: true }, undefined)).toBe("reattach");
  });
  it("чужой resume — gone; живой звонок не перехватывается — busy", () => {
    expect(decideHello({ callId: "call_a", detached: true }, "call_b")).toBe("gone");
    expect(decideHello({ callId: "call_a", detached: false }, undefined)).toBe("busy");
    expect(decideHello({ callId: "call_a", detached: false }, "call_a")).toBe("busy");
  });
});
