/**
 * Стык PLUG-117 (inspectConnectorTool — общий разбор ручек для звонка и `bb call connectors`)
 * и PLUG-115 (двухшаговые ручки, контракт §14.10 п. 2): confirm/confirm_token разрешены схемой,
 * но не обязательны; у обычной ручки required не трогается.
 */
import { describe, expect, it } from "vitest";
import { inspectConnectorTool } from "../src/mcp-client.js";

const schema = {
  type: "object",
  properties: {
    amount: { type: "number" },
    confirm: { type: "boolean" },
    confirm_token: { type: "string" },
  },
  required: ["amount", "confirm", "confirm_token"],
};

function cfg(twoStep: string[] | undefined) {
  return {
    id: "demo",
    transport: "stdio",
    command: ["/usr/bin/node", "/fake/server.js"],
    tools: { refund: "C" },
    defaultClass: "C",
    ...(twoStep ? { twoStep } : {}),
  } as any;
}

describe("интеграция 117+115: inspectConnectorTool и двухшаговая схема", () => {
  it("двухшаговая ручка: confirm/confirm_token сняты из required, класс и имя как у звонка", () => {
    const r = inspectConnectorTool({ name: "refund", inputSchema: schema } as any, cfg(["refund"]), {} as any, new Set());
    expect(r.status).toBe("active");
    expect(r.candidateName).toBe("demo__refund");
    expect(r.cls).toBe("C");
    const req = (r.geminiParams as any).required as string[];
    expect(req).toContain("amount");
    expect(req).not.toContain("confirm");
    expect(req).not.toContain("confirm_token");
  });

  it("обычная ручка: required не меняется", () => {
    const r = inspectConnectorTool({ name: "refund", inputSchema: schema } as any, cfg(undefined), {} as any, new Set());
    expect(r.status).toBe("active");
    const req = (r.geminiParams as any).required as string[];
    expect(req).toEqual(expect.arrayContaining(["amount", "confirm", "confirm_token"]));
  });

  it("коллизия имени в одном коннекторе отсекается по seenToolNames", () => {
    const seen = new Set<string>(["demo__refund"]);
    const r = inspectConnectorTool({ name: "refund", inputSchema: schema } as any, cfg(undefined), {} as any, seen);
    expect(r.status).toBe("skipped");
    expect(r.skipReason).toBe("name_collision");
  });
});
