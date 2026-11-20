// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

type Manager = typeof import("../src/favorites-manager.js");

function rpcResponse(result: unknown) {
  return { json: async () => ({ ok: true, result }) };
}

const snapshot = (
  version: number,
  favorites: Record<string, string[]> = {},
  modelLabels: Record<string, string> = {},
  config = { pinToTop: true, showQuickBar: true }
) => ({ version, favorites, modelLabels, config });

async function freshManager(): Promise<Manager> {
  vi.resetModules();
  return await import("../src/favorites-manager.js");
}

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("backend sync versioning (M8)", () => {
  it("applies the server snapshot on a quiet boot", async () => {
    const mgr = await freshManager();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/getFavorites")
          ? rpcResponse(snapshot(3, { codex: ["m1"] }, { "codex:m1": "M1" }))
          : rpcResponse(snapshot(4))
      )
    );
    const cancel = mgr.initBackendSync();
    await vi.waitFor(() => expect(mgr.getState().favorites.codex).toEqual(["m1"]));
    expect(mgr.getState().modelLabels["codex:m1"]).toBe("M1");
    cancel();
  });

  it("a late getFavorites answer cannot roll back a newer local star", async () => {
    const mgr = await freshManager();
    let resolveGet: ((v: unknown) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/getFavorites")) {
          // Pending until the test resolves it — the mutation lands meanwhile.
          return { json: () => new Promise((r) => (resolveGet = r)) };
        }
        return rpcResponse(snapshot(7, { codex: ["new-star"] }));
      })
    );
    const cancel = mgr.initBackendSync();
    await mgr.addFavorite("codex", "new-star"); // applies server v7
    expect(mgr.getState().favorites.codex).toEqual(["new-star"]);

    // The boot snapshot (v1, empty) finally arrives — it must be ignored:
    // both by version AND by the mutation counter guard.
    resolveGet!({ ok: true, result: snapshot(1) });
    await new Promise((r) => setTimeout(r, 0));
    expect(mgr.getState().favorites.codex).toEqual(["new-star"]);
    cancel();
  });

  it("a second mount cancels the first sync instead of stacking reads", async () => {
    const mgr = await freshManager();
    let resolveGet: ((v: unknown) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/getFavorites")) {
          return { json: () => new Promise((r) => (resolveGet = r)) };
        }
        return rpcResponse(snapshot(2));
      })
    );
    const cancel1 = mgr.initBackendSync();
    cancel1(); // unmount before the answer lands
    const cancel2 = mgr.initBackendSync();
    // Let both fetches reach their res.json() so resolvers are captured.
    await new Promise((r) => setTimeout(r, 0));
    resolveGet!({ ok: true, result: snapshot(9, { codex: ["x"] }) });
    await new Promise((r) => setTimeout(r, 0));
    // Only the SECOND sync's generation is live; it applies.
    expect(mgr.getState().favorites.codex).toEqual(["x"]);
    cancel2();
  });
});

describe("mutation RPC result handling (M9)", () => {
  it("failed add reconciles with getFavorites instead of keeping a ghost", async () => {
    const mgr = await freshManager();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const method = url.split("/").pop()!;
        calls.push(method);
        if (method === "addFavorite") return { json: async () => ({ ok: false, error: "nope" }) };
        return rpcResponse(snapshot(5));
      })
    );
    const ok = await mgr.addFavorite("codex", "ghost");
    expect(ok).toBe(false);
    expect(calls).toEqual(["addFavorite", "getFavorites"]);
    // Reconciled to the authoritative (empty) snapshot — no ghost star.
    expect(mgr.getState().favorites.codex).toBeUndefined();
  });

  it("add and remove are intent-explicit RPCs", async () => {
    const mgr = await freshManager();
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const method = url.split("/").pop()!;
        methods.push(method);
        return rpcResponse(snapshot(methods.length, { codex: ["m"] }));
      })
    );
    await mgr.addFavorite("codex", "m");
    await mgr.removeFavorite("codex", "m");
    expect(methods.slice(0, 2)).toEqual(["addFavorite", "removeFavorite"]);
  });
});

describe("labels lifecycle (m3)", () => {
  it("removeFavorite drops the stored label", async () => {
    const mgr = await freshManager();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/removeFavorite")
          ? rpcResponse(snapshot(2, {}, {}))
          : rpcResponse(snapshot(1, { codex: ["m"] }, { "codex:m": "M" }))
      )
    );
    await mgr.addFavorite("codex", "m", "M");
    expect(mgr.getState().modelLabels["codex:m"]).toBe("M");
    await mgr.removeFavorite("codex", "m");
    expect(mgr.getState().modelLabels["codex:m"]).toBeUndefined();
  });
});

describe("import validation (M12)", () => {
  it("rejects structurally invalid payloads without touching the store", async () => {
    const mgr = await freshManager();
    const fetchMock = vi.fn(async () => rpcResponse(snapshot(1)));
    vi.stubGlobal("fetch", fetchMock);
    expect(await mgr.importFavoritesJson('{"favorites":null}')).toBe(false);
    expect(await mgr.importFavoritesJson('{"favorites":{"codex":{"a":1}}}')).toBe(false);
    expect(await mgr.importFavoritesJson("not json")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mgr.getState().favorites).toEqual({});
  });

  it("accepts the CLI/UI export shape", async () => {
    const mgr = await freshManager();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcResponse(snapshot(4, { codex: ["a"] }, { "codex:a": "A" })))
    );
    const ok = await mgr.importFavoritesJson(
      JSON.stringify({
        version: 3,
        exportedAt: "t",
        favorites: { codex: ["a"] },
        modelLabels: { "codex:a": "A" },
      })
    );
    expect(ok).toBe(true);
    expect(mgr.getState().favorites.codex).toEqual(["a"]);
  });
});

describe("restricted storage (m5)", () => {
  it("module works when localStorage access throws", async () => {
    const desc = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    try {
      const mgr = await freshManager();
      expect(mgr.getState().favorites).toEqual({});
      vi.stubGlobal("fetch", vi.fn(async () => rpcResponse(snapshot(1, { codex: ["x"] }))));
      await mgr.addFavorite("codex", "x");
      expect(mgr.getState().favorites.codex).toEqual(["x"]);
    } finally {
      if (desc) Object.defineProperty(window, "localStorage", desc);
    }
  });
});

describe("boot sync races a mutation (review minor)", () => {
  it("a raced mutation triggers one re-read instead of dropping server favorites", async () => {
    const mgr = await freshManager();
    const calls: string[] = [];
    let resolveGet: ((v: unknown) => void) | null = null;
    let getCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const method = url.split("/").pop()!;
        calls.push(method);
        if (method === "getFavorites") {
          getCount++;
          if (getCount === 1) {
            return { json: () => new Promise((r) => (resolveGet = r)) };
          }
          return rpcResponse(snapshot(8, { codex: ["new-star", "from-other-device"] }));
        }
        return rpcResponse(snapshot(7, { codex: ["new-star"] }));
      })
    );
    const cancel = mgr.initBackendSync();
    // The local star lands while the boot read is still in flight.
    await mgr.addFavorite("codex", "new-star");
    resolveGet!({ ok: true, result: snapshot(1) });
    await vi.waitFor(() =>
      expect(mgr.getState().favorites.codex).toEqual(["new-star", "from-other-device"])
    );
    expect(calls.filter((c) => c === "getFavorites").length).toBe(2);
    cancel();
  });
});

describe("updateConfig honest result (review minor)", () => {
  it("returns false and snaps the value back when the server refuses", async () => {
    const mgr = await freshManager();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        rpcResponse({ success: false, config: { pinToTop: true, showQuickBar: true } })
      )
    );
    const ok = await mgr.updateConfig({ pinToTop: false });
    expect(ok).toBe(false);
    expect(mgr.getState().pinToTop).toBe(true);
  });

  it("returns true and applies the echoed config on success", async () => {
    const mgr = await freshManager();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        rpcResponse({ success: true, config: { pinToTop: false, showQuickBar: true } })
      )
    );
    const ok = await mgr.updateConfig({ pinToTop: false });
    expect(ok).toBe(true);
    expect(mgr.getState().pinToTop).toBe(false);
  });
});

describe("legacy bare-modelId entries (review minor)", () => {
  it("toggleFavorite('M · route') removes the stored 'M'", async () => {
    const mgr = await freshManager();
    const bodies: { modelId?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        const method = url.split("/").pop()!;
        if (method === "getFavorites") {
          return rpcResponse(snapshot(5, { codex: ["M"] }));
        }
        if (method === "removeFavorite") {
          bodies.push(init?.body ? JSON.parse(init.body) : {});
          return rpcResponse(snapshot(6, {}));
        }
        return rpcResponse(snapshot(7));
      })
    );
    const cancel = mgr.initBackendSync();
    await vi.waitFor(() => expect(mgr.isFavorite("codex", "M")).toBe(true));
    const added = await mgr.toggleFavorite("codex", "M · route");
    expect(added).toBe(false);
    expect(bodies.length).toBe(1);
    expect(bodies[0].modelId).toBe("M");
    cancel();
  });
});
