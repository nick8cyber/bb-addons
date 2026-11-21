import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { rpcContract } from "../server.js";
import type { ProviderIdentity } from "../src/store.js";

type RpcHandler = (input: never) => Promise<unknown>;
type CliRunner = (
  argv: string[],
  ctx: unknown
) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

type FakeOptions = {
  providers?: ProviderIdentity[];
  rejectSettings?: boolean;
  withCatalog?: boolean;
};

function makeBb(
  initialKv: Record<string, unknown> = {},
  initialSettings: Record<string, unknown> = {},
  options: FakeOptions = {}
) {
  const kv = new Map<string, unknown>(Object.entries(initialKv));
  const settings = { ...initialSettings };
  const handlers = new Map<string, RpcHandler>();
  let cliRun: CliRunner | null = null;
  const setCalls: Record<string, unknown>[] = [];

  const bb = {
    pluginId: "favorite-models",
    log: { info: () => {}, warn: () => {}, error: () => {} },
    sdk: { providers: { list: async () => options.providers ?? [] } },
    server: options.withCatalog ? { loopbackBaseUrl: "http://127.0.0.1:38886" } : undefined,
    settings: {
      define: () => ({
        get: async () => settings,
        experimental_set: async (values: Record<string, unknown>) => {
          setCalls.push(values);
          if (options.rejectSettings) throw new Error("Settings unavailable");
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

async function loadPlugin(
  kv: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
  options: FakeOptions = {}
) {
  const ctx = makeBb(kv, settings, options);
  await plugin(ctx.bb);
  return ctx;
}

afterEach(() => vi.unstubAllGlobals());

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

describe("first-write legacy migration (review blocker 3)", () => {
  it("CLI add does not wipe a legacy favorites:map", async () => {
    const ctx = await loadPlugin({ "favorites:map": { codex: ["gpt-old"] } });
    await ctx.cli(["add", "codex", "gpt-new"]);
    const res = await call(ctx, "getFavorites", null);
    expect(res.favorites.codex).toContain("gpt-old");
    expect(res.favorites.codex).toContain("gpt-new");
    expect(ctx.kv.has("favorites:map")).toBe(false);
  });

  it("full clear migrates before wiping, so labels do not resurrect", async () => {
    const ctx = await loadPlugin({
      "favorites:map": { codex: ["gpt-old"] },
      "favorites:labels": { "codex:gpt-old": "OLD" },
    });
    await ctx.cli(["clear"]);
    const res = await call(ctx, "getFavorites", null);
    expect(res.favorites).toEqual({});
    expect(res.modelLabels).toEqual({});
  });
});

describe("model ids containing modifier words (review minor)", () => {
  it("add and remove round-trip 'foo-alt-2' unmangled", async () => {
    const ctx = await loadPlugin();
    const add = await call(ctx, "addFavorite", { providerId: "codex", modelId: "foo-alt-2" });
    expect(add.favorites.codex).toEqual(["foo-alt-2"]);
    const rm = await call(ctx, "removeFavorite", { providerId: "codex", modelId: "foo-alt-2" });
    expect(rm.favorites.codex).toBeUndefined();
  });
});

describe("provider identity migration", () => {
  const providers = [
    { id: "acp-opencode", displayName: "opencode" },
    { id: "acp-devin", displayName: "Devin" },
    { id: "agy", displayName: "Antigravity (agy)" },
    { id: "acp-antigravity", displayName: "Google Antigravity" },
    { id: "acp-web-gemini", displayName: "ACP Web Gemini" },
    { id: "claude-code", displayName: "Claude Code" },
    { id: "acp-example", displayName: "Example Provider" },
  ];

  it("merges and rekeys a versioned store inside the lock only once", async () => {
    const ctx = await loadPlugin({
      "favorites:store": {
        version: 9,
        favorites: {
          devin: ["Swe-2"], opencode: ["A"], "acp-opencode": ["B", "A"],
          "provider-claude-code": ["Claude"], "example-provider": ["C"],
          agy: ["Agy model", "Shared Gemini", "Web · acp-web-gemini"],
        },
        modelLabels: {
          "devin:Swe-2": "Swe-2", "opencode:A": "Alpha",
          "agy:Shared Gemini": "Shared Gemini · Google Antigravity",
          "agy:Web · acp-web-gemini": "Web · acp-web-gemini",
        },
      },
    }, {}, { providers });

    const [first, simultaneous] = await Promise.all([
      call(ctx, "getFavorites", null), call(ctx, "getFavorites", null),
    ]);
    expect(first.version).toBe(10);
    expect(simultaneous).toEqual(first);
    expect(first.favorites).toEqual({
      "acp-devin": ["Swe-2"], "acp-opencode": ["A", "B"], "claude-code": ["Claude"],
      "acp-example": ["C"], agy: ["Agy model"], "acp-antigravity": ["Shared Gemini"],
      "acp-web-gemini": ["Web · acp-web-gemini"],
    });
    expect(first.modelLabels).toEqual({
      "acp-devin:Swe-2": "Swe-2", "acp-opencode:A": "Alpha",
      "acp-antigravity:Shared Gemini": "Shared Gemini · Google Antigravity",
      "acp-web-gemini:Web · acp-web-gemini": "Web · acp-web-gemini",
    });
    expect(ctx.kv.get("favorites:store")).toMatchObject({ version: 10 });
  });

  it("migrates split keys before the first write and preserves ambiguous agy records there", async () => {
    const ctx = await loadPlugin({
      "favorites:map": { opencode: ["Old"], agy: ["Gemini 3.8 Flash"] },
      "favorites:labels": { "opencode:Old": "Old label" },
    }, {}, { providers });
    const result = await call(ctx, "addFavorite", { providerId: "opencode", modelId: "New" });
    expect(result.favorites).toEqual({ "acp-opencode": ["New", "Old"], agy: ["Gemini 3.8 Flash"] });
    expect(result.modelLabels).toEqual({ "acp-opencode:Old": "Old label" });
    expect(ctx.kv.has("favorites:map")).toBe(false);
  });
});

describe("write compatibility", () => {
  it("requires a baseVersion and refuses a stale import under the write lock", async () => {
    const ctx = await loadPlugin();
    const parsed = await rpcContract.setFavorites.input["~standard"].validate({ favorites: {} });
    expect(parsed.issues).toBeDefined();
    const current = await call(ctx, "addFavorite", { providerId: "codex", modelId: "Other device" });
    await expect(call(ctx, "setFavorites", { baseVersion: 0, favorites: { codex: ["Old"] } }))
      .rejects.toMatchObject({ code: "conflict", [Symbol.for("@get-bb/plugin-sdk/rpc-refusal")]: true });
    expect(await call(ctx, "getFavorites", null)).toEqual(current);
    const replaced = await call(ctx, "setFavorites", { baseVersion: current.version, favorites: { devin: ["New"] } });
    expect(replaced.favorites).toEqual({ "acp-devin": ["New"] });
  });

  it("serves legacy toggles atomically using the canonical provider group", async () => {
    const ctx = await loadPlugin();
    const [on, off] = await Promise.all([
      call(ctx, "toggleFavorite", { providerId: "devin", modelId: "Swe-2", label: "Swe-2" }),
      call(ctx, "toggleFavorite", { providerId: "acp-devin", modelId: "Swe-2" }),
    ]);
    expect(on).toMatchObject({ isFavorite: true, favorites: { "acp-devin": ["Swe-2"] } });
    expect(off).toMatchObject({ isFavorite: false, favorites: {}, modelLabels: {} });
  });

  it("keeps the legacy settings key if experimental_set fails and can retry on load", async () => {
    const initial = { "favorites:config": { pinToTop: false } };
    const failed = await loadPlugin(initial, {}, { rejectSettings: true });
    expect(failed.kv.get("favorites:config")).toEqual(initial["favorites:config"]);
    const retried = await loadPlugin(Object.fromEntries(failed.kv));
    expect(retried.kv.has("favorites:config")).toBe(false);
    expect(retried.settings.pinToTop).toBe(false);
  });
});

describe("favorites doctor", () => {
  const stored = {
    version: 4,
    favorites: { "provider-pi": ["Model", "Multi"], removed: ["Orphan"], opencode: ["M"] },
    modelLabels: {
      "provider-pi:Model": "Model · router",
      "provider-pi:Multi · router-1": "Multi · router-1",
      "provider-pi:Multi · router-2": "Multi · router-2",
      "default:Ghost": "Ghost",
      "removed:Orphan": "Orphan",
      "opencode:M": "M",
    },
  };

  it("reports without writing and explicitly repairs using the full catalog", async () => {
    const ctx = await loadPlugin({ "favorites:store": stored }, {}, { withCatalog: true });
    const fetchCatalog = vi.fn(async () => Response.json([
      { id: "pi", displayName: "Pi", enabled: false },
      { id: "acp-opencode", displayName: "opencode", enabled: true },
    ]));
    vi.stubGlobal("fetch", fetchCatalog);
    const report = await ctx.cli(["doctor"]);
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain("Unknown provider removed");
    expect(report.stdout).toContain("Missing route for pi:Model");
    expect(report.stdout).toContain("Route ambiguous for pi:Multi");
    expect(report.stdout).toContain("Default label default:Ghost");
    expect(fetchCatalog.mock.calls.length).toBe(1);
    expect(ctx.kv.get("favorites:store")).toEqual(stored);

    const fixed = await ctx.cli(["doctor", "--fix"]);
    expect(fixed.stdout).toContain("Repairs applied.");
    expect(ctx.kv.get("favorites:store")).toMatchObject({
      favorites: { pi: ["Model · router", "Multi"], "acp-opencode": ["M"] },
      modelLabels: {
        "pi:Model · router": "Model · router",
        "pi:Multi · router-1": "Multi · router-1",
        "pi:Multi · router-2": "Multi · router-2",
        "acp-opencode:M": "M",
      },
    });
    expect(ctx.kv.get("favorites:store")).not.toHaveProperty("favorites.removed");
    expect(ctx.kv.get("favorites:store")).not.toHaveProperty("modelLabels.default:Ghost");
    const afterFix = ctx.kv.get("favorites:store");
    const rerun = await ctx.cli(["doctor", "--fix"]);
    expect(rerun.stdout).toContain("Route ambiguous");
    expect(rerun.stdout).not.toContain("Repairs applied.");
    expect(ctx.kv.get("favorites:store")).toEqual(afterFix);
  });

  it("has no write path when the full catalog is unavailable", async () => {
    const ctx = await loadPlugin({ "favorites:store": stored }, {}, { withCatalog: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    expect(await ctx.cli(["doctor", "--fix"])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("directory") });
    expect(ctx.kv.get("favorites:store")).toEqual(stored);
    expect((await ctx.cli(["doctor", "--other"])).exitCode).toBe(1);
  });
});
