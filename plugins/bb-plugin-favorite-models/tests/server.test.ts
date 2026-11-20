import { describe, expect, it, beforeEach } from "vitest";
import plugin from "../server.js";

type RpcHandler = (input: never) => Promise<unknown>;
type CliRunner = (
  argv: string[],
  ctx: unknown
) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

function makeBb(initialKv: Record<string, unknown> = {}, initialSettings: Record<string, unknown> = {}) {
  const kv = new Map<string, unknown>(Object.entries(initialKv));
  const settings = { ...initialSettings };
  const handlers = new Map<string, RpcHandler>();
  let cliRun: CliRunner | null = null;
  const setCalls: Record<string, unknown>[] = [];

  const bb = {
    pluginId: "favorite-models",
    log: { info: () => {}, warn: () => {}, error: () => {} },
    settings: {
      define: () => ({
        get: async () => settings,
        experimental_set: async (values: Record<string, unknown>) => {
          setCalls.push(values);
          Object.assign(settings, values);
          return settings;
        },
        onChange: () => {},
      }),
    },
    storage: {
      kv: {
        get: async <T>(key: string) => kv.get(key) as T | undefined,
        set: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
        delete: async (key: string) => {
          kv.delete(key);
        },
        list: async () => [...kv.keys()],
      },
    },
    rpc: {
      register: (_contract: unknown, impl: Record<string, RpcHandler>) => {
        for (const [k, v] of Object.entries(impl)) handlers.set(k, v);
      },
    },
    cli: {
      register: (reg: { run: CliRunner }) => {
        cliRun = reg.run;
      },
    },
    onDispose: () => {},
  };

  return {
    bb: bb as never,
    kv,
    settings,
    handlers,
    setCalls,
    cli: (argv: string[]) => {
      if (!cliRun) throw new Error("cli not registered");
      return cliRun(argv, {});
    },
  };
}

async function loadPlugin(kv: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  const ctx = makeBb(kv, settings);
  await plugin(ctx.bb);
  return ctx;
}

const call = (ctx: Awaited<ReturnType<typeof loadPlugin>>, method: string, input: unknown) =>
  ctx.handlers.get(method)!(input as never) as Promise<{
    version: number;
    favorites: Record<string, string[]>;
    modelLabels: Record<string, string>;
    config: { pinToTop: boolean; showQuickBar: boolean };
  }>;

describe("server store (M10)", () => {
  it("merges concurrent additions instead of last-write-wins", async () => {
    const ctx = await loadPlugin();
    const [a, b] = await Promise.all([
      call(ctx, "addFavorite", { providerId: "codex", modelId: "model-a" }),
      call(ctx, "addFavorite", { providerId: "codex", modelId: "model-b" }),
    ]);
    const final = await call(ctx, "getFavorites", null);
    expect(final.favorites.codex.sort()).toEqual(["model-a", "model-b"]);
    expect(b.version).toBeGreaterThan(a.version);
  });

  it("keeps concurrent config writes and bumps version monotonically", async () => {
    const ctx = await loadPlugin();
    const results = await Promise.all([
      call(ctx, "addFavorite", { providerId: "codex", modelId: "x" }),
      call(ctx, "addFavorite", { providerId: "agy", modelId: "y" }),
      call(ctx, "removeFavorite", { providerId: "codex", modelId: "x" }),
    ]);
    const versions = results.map((r) => r.version).sort((m, n) => m - n);
    expect(versions).toEqual([1, 2, 3]);
    const final = await call(ctx, "getFavorites", null);
    expect(final.favorites).toEqual({ agy: ["y"] });
  });

  it("migrates legacy split keys into the single versioned store", async () => {
    const ctx = await loadPlugin({
      "favorites:map": { openai: ["gpt-5.4"] },
      "favorites:labels": { "openai:gpt-5.4": "GPT" },
    });
    const res = await call(ctx, "getFavorites", null);
    expect(res.favorites).toEqual({ codex: ["gpt-5.4"] });
    expect(res.modelLabels["codex:gpt-5.4"]).toBe("GPT");
    expect(ctx.kv.has("favorites:store")).toBe(true);
    expect(ctx.kv.has("favorites:map")).toBe(false);
  });
});

describe("server RPC add/remove (M9, m3)", () => {
  it("add is idempotent — a stale tab cannot invert an existing entry", async () => {
    const ctx = await loadPlugin();
    await call(ctx, "addFavorite", { providerId: "codex", modelId: "m" });
    const res = await call(ctx, "addFavorite", { providerId: "codex", modelId: "m" });
    expect(res.favorites.codex).toEqual(["m"]);
  });

  it("remove drops the model label (m3)", async () => {
    const ctx = await loadPlugin();
    await call(ctx, "addFavorite", { providerId: "codex", modelId: "m", label: "M" });
    const res = await call(ctx, "removeFavorite", { providerId: "codex", modelId: "m" });
    expect(res.favorites.codex).toBeUndefined();
    expect(res.modelLabels["codex:m"]).toBeUndefined();
  });

  it("clear drops all labels of the provider", async () => {
    const ctx = await loadPlugin();
    await call(ctx, "addFavorite", { providerId: "codex", modelId: "a", label: "A" });
    await call(ctx, "addFavorite", { providerId: "agy", modelId: "b", label: "B" });
    const res = await call(ctx, "clearFavorites", { providerId: "codex" });
    expect(res.favorites.codex).toBeUndefined();
    expect(res.modelLabels["agy:b"]).toBe("B");
    expect(Object.keys(res.modelLabels)).toEqual(["agy:b"]);
  });

  it("normalizes provider keys on the write path (M11)", async () => {
    const ctx = await loadPlugin();
    const res = await call(ctx, "addFavorite", { providerId: "OpenAI", modelId: "gpt-5.4" });
    expect(res.favorites.codex).toEqual(["gpt-5.4"]);
    expect(res.favorites.OpenAI).toBeUndefined();
  });
});

describe("updateConfig (M13)", () => {
  it("writes through to bb.settings, not a KV override", async () => {
    const ctx = await loadPlugin();
    const res = (await call(ctx, "updateConfig", { showQuickBar: false })) as unknown as {
      success: boolean;
      config: { pinToTop: boolean; showQuickBar: boolean };
    };
    expect(res.success).toBe(true);
    expect(res.config.showQuickBar).toBe(false);
    expect(ctx.settings.showQuickBar).toBe(false);
    expect(ctx.setCalls).toEqual([{ showQuickBar: false }]);
    // No KV config key is created — settings stay the single source.
    expect([...ctx.kv.keys()].filter((k) => k.includes("config"))).toEqual([]);
  });

  it("migrates a legacy KV config into settings once", async () => {
    const ctx = await loadPlugin({ "favorites:config": { pinToTop: false } });
    expect(ctx.settings.pinToTop).toBe(false);
    expect(ctx.kv.has("favorites:config")).toBe(false);
    const res = await call(ctx, "getFavorites", null);
    expect(res.config.pinToTop).toBe(false);
  });
});

describe("cli favorites (m1, m2)", () => {
  it("remove resolves the normalized provider key and reports truthfully", async () => {
    const ctx = await loadPlugin();
    await call(ctx, "addFavorite", { providerId: "codex", modelId: "A" });
    // Stored under 'codex'; removing via the 'openai' alias must hit it.
    const ok = await ctx.cli(["remove", "openai", "A"]);
    expect(ok.exitCode).toBe(0);
    const res = await call(ctx, "getFavorites", null);
    expect(res.favorites.codex).toBeUndefined();
  });

  it("remove of a missing model exits non-zero instead of claiming success", async () => {
    const ctx = await loadPlugin();
    const res = await ctx.cli(["remove", "codex", "nope"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("nope");
  });

  it("export emits the import-compatible wrapper (m2)", async () => {
    const ctx = await loadPlugin();
    await call(ctx, "addFavorite", { providerId: "codex", modelId: "A", label: "LA" });
    const res = await ctx.cli(["export"]);
    const parsed = JSON.parse(res.stdout!);
    expect(parsed.favorites).toEqual({ codex: ["A"] });
    expect(parsed.modelLabels["codex:A"]).toBe("LA");
    expect(parsed).toHaveProperty("version");
  });
});
