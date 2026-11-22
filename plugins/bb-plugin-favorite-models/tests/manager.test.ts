// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

type Manager = typeof import("../src/favorites-manager.js");

function rpcResponse(result: unknown) {
  return { json: async () => ({ ok: true, result }) };
}

const snapshot = (
  version: number,
  favorites: Record<string, string[]> = {},
  modelLabels: Record<string, string> = {},
  config = { pinToTop: true }
) => ({ version, favorites, modelLabels, config });

async function freshManager(): Promise<Manager> {
  vi.resetModules();
  return await import("../src/favorites-manager.js");
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.mocked(toast.error).mockClear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
        rpcResponse({ success: false, config: { pinToTop: true } })
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
        rpcResponse({ success: true, config: { pinToTop: false } })
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

describe("live sync and the pending queue", () => {
  it("refetches on focus, on becoming visible, and periodically, then detaches", async () => {
    vi.useFakeTimers();
    const mgr = await freshManager();
    let remote = snapshot(1, { codex: ["initial"] });
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const fetchMock = vi.fn(async () => rpcResponse(remote));
    vi.stubGlobal("fetch", fetchMock);
    const dispose = mgr.initBackendSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.getState().favorites.codex).toEqual(["initial"]);

    // A native settings change does not have to update favorites.version.
    remote = snapshot(1, { codex: ["initial"] }, {}, { pinToTop: false });
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.getState()).toMatchObject({ pinToTop: false });

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    visibility = "visible";
    remote = snapshot(2, { codex: ["another tab"] });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.getState().favorites.codex).toEqual(["another tab"]);

    remote = snapshot(3, { codex: ["background update"] });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mgr.getState().favorites.codex).toEqual(["background update"]);
    dispose();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("replays pending intents over another tab's data while retrying in order", async () => {
    vi.useFakeTimers();
    const mgr = await freshManager();
    let attempts = 0;
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const method = url.split("/").pop();
      if (method === "getFavorites") return rpcResponse(snapshot(3, { codex: ["remote"] }));
      const { modelId } = JSON.parse(init.body as string);
      writes.push(modelId);
      if (++attempts === 1) throw new TypeError("offline");
      if (modelId === "first") return rpcResponse(snapshot(4, { codex: ["first", "remote"] }));
      return rpcResponse(snapshot(5, { codex: ["second", "first", "remote"] }));
    }));

    const first = mgr.addFavorite("codex", "first");
    const second = mgr.addFavorite("codex", "second");
    await mgr.refreshFavorites();
    expect(writes).toEqual(["first"]);
    expect(mgr.getState().favorites.codex).toEqual(["second", "first", "remote"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(writes).toEqual(["first", "first", "second"]);
    expect(mgr.getState().favorites.codex).toEqual(["second", "first", "remote"]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("rolls back only the failed intent after exhausting retries", async () => {
    vi.useFakeTimers();
    const mgr = await freshManager();
    let failures = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/getFavorites")) return rpcResponse(snapshot(3, { codex: ["server"] }));
      if (JSON.parse(init.body as string).modelId === "lost") {
        failures++;
        return new Response("Unavailable", { status: 503 });
      }
      return rpcResponse(snapshot(4, { codex: ["kept", "server"] }));
    }));
    await mgr.refreshFavorites();

    const lost = mgr.addFavorite("codex", "lost");
    const kept = mgr.addFavorite("codex", "kept");
    expect(mgr.getState().favorites.codex).toEqual(["kept", "lost", "server"]);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(await Promise.all([lost, kept])).toEqual([false, true]);
    expect(failures).toBe(4);
    expect(mgr.getState().favorites.codex).toEqual(["kept", "server"]);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("restores unconfirmed work from the tab's session after reload", async () => {
    vi.useFakeTimers();
    const first = await freshManager();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/getFavorites")) return rpcResponse(snapshot(1, { codex: ["remote"] }));
      throw new TypeError("offline");
    }));
    const dispose = first.initBackendSync();
    await vi.advanceTimersByTimeAsync(0);
    void first.addFavorite("codex", "pending");
    await vi.advanceTimersByTimeAsync(0);
    expect(first.getState().favorites.codex).toEqual(["pending", "remote"]);
    dispose();

    const reloaded = await freshManager();
    expect(reloaded.getState().favorites.codex).toEqual(["pending", "remote"]);
    const fetchMock = vi.fn(async (url: string) => url.endsWith("/getFavorites")
      ? rpcResponse(snapshot(1, { codex: ["remote"] }))
      : rpcResponse(snapshot(2, { codex: ["pending", "remote"] })));
    vi.stubGlobal("fetch", fetchMock);
    const close = reloaded.initBackendSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/addFavorite"))).toHaveLength(1);
    expect(reloaded.getState().favorites.codex).toEqual(["pending", "remote"]);
    expect(sessionStorage.length).toBe(0);
    close();
  });

  it("uses the confirmed version for import and pulls the winning snapshot after a 409", async () => {
    const mgr = await freshManager();
    let remote = snapshot(3, { codex: ["A"] });
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/getFavorites")) return rpcResponse(remote);
      sent.push(JSON.parse(init.body as string));
      remote = snapshot(4, { codex: ["A", "other device"] });
      return Response.json({ ok: false, error: { code: "conflict" } }, { status: 409 });
    }));
    await mgr.refreshFavorites();
    const imported = mgr.importFavoritesJson(JSON.stringify({ version: 1, favorites: { codex: ["incoming"] } }));
    expect(mgr.getState().favorites.codex).toEqual(["incoming"]);
    expect(await imported).toBe(false);
    expect(sent).toEqual([{ baseVersion: 3, favorites: { codex: ["incoming"] }, modelLabels: {} }]);
    expect(mgr.getState().favorites.codex).toEqual(["A", "other device"]);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Избранное изменилось на сервере"));
  });
});
