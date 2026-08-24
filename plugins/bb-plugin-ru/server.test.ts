import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "./server.js";

async function load(settings: Record<string, boolean> = {}) {
  const host = createFakePluginHost({ pluginId: "ru", settings });
  await plugin(host.bb);
  return host;
}

describe("копилка непереведённых строк", () => {
  it("ничего не пишет, пока сбор выключен", async () => {
    const { harness } = await load();
    const result = await harness.behavior.callRpc("reportMissing", {
      strings: ["Merge base"],
    });
    expect(result).toEqual({ accepted: 0, collecting: false });

    const status = await harness.behavior.callRpc("status", null);
    expect(status).toEqual({ collecting: false, missingCount: 0 });
  });

  it("накапливает строки и считает повторы", async () => {
    const { harness } = await load({ collectMissing: true });
    await harness.behavior.callRpc("reportMissing", {
      strings: ["Merge base", "Worktree", "Merge base"],
    });
    await harness.behavior.callRpc("reportMissing", { strings: ["Merge base"] });

    const { rows } = (await harness.behavior.callRpc("listMissing", {
      limit: 10,
    })) as { rows: { text: string; count: number }[] };

    expect(rows.map((row) => [row.text, row.count])).toEqual([
      ["Merge base", 3],
      ["Worktree", 1],
    ]);
  });

  it("сжимает пробелы и отбрасывает пустое и слишком длинное", async () => {
    const { harness } = await load({ collectMissing: true });
    await harness.behavior.callRpc("reportMissing", {
      strings: ["  Merge   base ", "   ", "x".repeat(201)],
    });

    const { rows } = (await harness.behavior.callRpc("listMissing", {
      limit: 10,
    })) as { rows: { text: string }[] };
    expect(rows.map((row) => row.text)).toEqual(["Merge base"]);
  });

  it("чистится по запросу", async () => {
    const { harness } = await load({ collectMissing: true });
    await harness.behavior.callRpc("reportMissing", { strings: ["Worktree"] });
    expect(await harness.behavior.callRpc("clearMissing", null)).toEqual({
      removed: 1,
    });
    expect(await harness.behavior.callRpc("status", null)).toEqual({
      collecting: true,
      missingCount: 0,
    });
  });

  it("отклоняет пачку больше лимита на границе схемы", async () => {
    const { harness } = await load({ collectMissing: true });
    await expect(
      harness.behavior.callRpc("reportMissing", {
        strings: Array.from({ length: 201 }, (_, index) => `s${index}`),
      }),
    ).rejects.toThrow();
  });
});

describe("bb ru", () => {
  it("показывает состояние и подсказывает, как включить сбор", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["stats"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("сбор: выключен");
    expect(result.stdout).toContain("bb plugin config ru set collectMissing true");
  });

  it("печатает собранные строки по убыванию частоты", async () => {
    const { harness } = await load({ collectMissing: true });
    await harness.behavior.callRpc("reportMissing", {
      strings: ["Worktree", "Merge base", "Merge base"],
    });

    const result = await harness.behavior.runCli(["missing", "--limit", "1"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Merge base");
    expect(result.stdout).not.toContain("Worktree");
  });

  it("отдаёт JSON по флагу", async () => {
    const { harness } = await load({ collectMissing: true });
    await harness.behavior.callRpc("reportMissing", { strings: ["Worktree"] });
    const result = await harness.behavior.runCli(["missing", "--json"]);
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({
      rows: [{ text: "Worktree", count: 1 }],
    });
  });

  it("чистит копилку", async () => {
    const { harness } = await load({ collectMissing: true });
    await harness.behavior.callRpc("reportMissing", { strings: ["Worktree"] });
    const result = await harness.behavior.runCli(["clear"]);
    expect(result.stdout).toContain("удалено строк: 1");
  });

  it("ругается на неизвестную команду", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["nonsense"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("неизвестная команда");
  });
});
