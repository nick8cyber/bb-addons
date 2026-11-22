/**
 * bb-plugin-favorite-models — Backend server entry.
 *
 * Implements persistent storage for favorite models, RPC data plane, and CLI commands.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  dropLabels,
  labelKey,
  migrateStore,
  normalizeModelKey,
  normalizeProviderId,
  sanitizeStore,
  type FavoritesMap,
  type FavoritesSnapshot,
  type ModelLabels,
  type ProviderIdentity,
} from "./src/store.js";
import { inspectFavorites } from "./src/doctor.js";

const STORE_KEY = "favorites:store";
const LEGACY_MAP_KEY = "favorites:map";
const LEGACY_LABELS_KEY = "favorites:labels";
const LEGACY_CONFIG_KEY = "favorites:config";

const providerDirectory = z.array(z.object({ id: z.string(), displayName: z.string() }));

const snapshotOutput = z.object({
  version: z.number(),
  providers: providerDirectory.optional(),
  favorites: z.record(z.string(), z.array(z.string())),
  modelLabels: z.record(z.string(), z.string()),
  config: z.object({
    pinToTop: z.boolean(),
  }),
});

export const rpcContract = defineRpcContract({
  getFavorites: {
    input: z.null(),
    output: snapshotOutput,
  },
  addFavorite: {
    input: z.object({
      providerId: z.string(),
      modelId: z.string(),
      label: z.string().optional(),
    }),
    output: snapshotOutput,
  },
  removeFavorite: {
    input: z.object({
      providerId: z.string(),
      modelId: z.string(),
    }),
    output: snapshotOutput,
  },
  // Compatibility with tabs opened before the intent-explicit RPCs.
  toggleFavorite: {
    input: z.object({
      providerId: z.string(),
      modelId: z.string(),
      label: z.string().optional(),
    }),
    output: snapshotOutput.extend({ isFavorite: z.boolean() }),
  },
  setFavorites: {
    input: z.object({
      baseVersion: z.number().int().nonnegative(),
      favorites: z.record(z.string(), z.array(z.string())),
      modelLabels: z.record(z.string(), z.string()).optional(),
    }),
    output: snapshotOutput,
  },
  clearFavorites: {
    input: z.object({
      providerId: z.string().nullable().optional(),
    }),
    output: snapshotOutput,
  },
  updateConfig: {
    input: z.object({
      pinToTop: z.boolean().optional(),
    }),
    output: z.object({
      success: z.boolean(),
      config: z.object({
        pinToTop: z.boolean(),
      }),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-favorite-models loaded");

  const settings = bb.settings.define({
    pinToTop: {
      type: "boolean",
      label: "Pin favorites to top of model dropdown",
      default: true,
    },
  });

  // Mutations serialize through this chain: BB's KV upserts single keys, so a
  // read-modify-write under the lock plus a version counter makes concurrent
  // writers (RPC tabs, CLI) merge instead of losing each other's updates (M10).
  let writeQueue: Promise<unknown> = Promise.resolve();
  function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  let providers: ProviderIdentity[] | undefined;
  let directoryFetchedAt = -Infinity;
  let directoryRequest: Promise<ProviderIdentity[]> | undefined;

  const fetchProviderCatalog = async () => {
    // The picker SDK list is scoped to a host and omits disabled providers.
    // The full BB catalog also lists providers that can be enabled again.
    const url = new URL("/api/v1/system/providers/catalog", bb.server.loopbackBaseUrl);
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new Error(`Provider catalog returned HTTP ${response.status}`);
    return providerDirectory.parse(await response.json());
  };

  const loadProviders = async (): Promise<ProviderIdentity[]> => {
    if (Date.now() - directoryFetchedAt < 15_000) return providers ?? [];
    if (!directoryRequest) {
      directoryRequest = fetchProviderCatalog()
        .catch(async () => providerDirectory.parse(await bb.sdk.providers.list()))
        .then((found) => (providers = found))
        .catch((err) => {
          bb.log.info(`Could not load provider directory: ${String(err)}`);
          return providers ?? [];
        })
        .finally(() => {
          directoryFetchedAt = Date.now();
          directoryRequest = undefined;
        });
    }
    return directoryRequest;
  };

  /** Run inside withStoreLock, including the migration of already versioned keys. */
  const loadOrMigrate = async (
    directory: readonly ProviderIdentity[],
    persist = true
  ): Promise<FavoritesSnapshot> => {
    const existing = await bb.storage.kv.get<FavoritesSnapshot>(STORE_KEY);
    if (existing && typeof existing.version === "number") {
      const migrated = migrateStore(existing.favorites, existing.modelLabels, directory);
      if (JSON.stringify(existing.favorites) === JSON.stringify(migrated.favorites) &&
          JSON.stringify(existing.modelLabels) === JSON.stringify(migrated.modelLabels)) {
        return existing;
      }
      const snapshot = { ...migrated, version: existing.version + 1 };
      if (persist) await bb.storage.kv.set(STORE_KEY, snapshot);
      return snapshot;
    }
    const legacyMap = await bb.storage.kv.get<FavoritesMap>(LEGACY_MAP_KEY);
    const legacyLabels = await bb.storage.kv.get<ModelLabels>(LEGACY_LABELS_KEY);
    if (legacyMap === undefined && legacyLabels === undefined) {
      return { version: 0, favorites: {}, modelLabels: {} };
    }
    const snapshot = { ...migrateStore(legacyMap ?? {}, legacyLabels ?? {}, directory), version: 1 };
    if (persist) {
      await bb.storage.kv.set(STORE_KEY, snapshot);
      await bb.storage.kv.delete(LEGACY_MAP_KEY);
      await bb.storage.kv.delete(LEGACY_LABELS_KEY);
    }
    return snapshot;
  };

  const readStore = (directory: readonly ProviderIdentity[]): Promise<FavoritesSnapshot> =>
    withStoreLock(() => loadOrMigrate(directory));

  const writeStore = (
    directory: readonly ProviderIdentity[],
    mutate: (snapshot: FavoritesSnapshot) => void
  ): Promise<FavoritesSnapshot> =>
    withStoreLock(async () => {
      const existing = await loadOrMigrate(directory);
      const snapshot: FavoritesSnapshot = {
        ...existing,
        favorites: { ...existing.favorites },
        modelLabels: { ...existing.modelLabels },
      };
      mutate(snapshot);
      const { favorites, modelLabels } = sanitizeStore(snapshot.favorites, snapshot.modelLabels, directory);
      const next = { version: snapshot.version + 1, favorites, modelLabels };
      await bb.storage.kv.set(STORE_KEY, next);
      return next;
    });

  function addModel(s: FavoritesSnapshot, provider: string, model: string, label?: string): void {
    const list = s.favorites[provider] ?? [];
    if (!list.includes(model)) s.favorites[provider] = [model, ...list];
    if (label) s.modelLabels[labelKey(provider, model)] = label;
  }

  function removeModel(s: FavoritesSnapshot, provider: string, model: string): void {
    const rest = (s.favorites[provider] ?? []).filter((id) => id !== model);
    if (rest.length === 0) delete s.favorites[provider];
    else s.favorites[provider] = rest;
    delete s.modelLabels[labelKey(provider, model)];
  }

  const getConfig = async () => {
    const s = await settings.get();
    return {
      pinToTop: s.pinToTop ?? true,
    };
  };

  const withConfig = async (snapshot: FavoritesSnapshot) => ({
    ...snapshot,
    ...(providers ? { providers } : {}),
    config: await getConfig(),
  });

  // One-off migration of the pre-refactor KV config override into real BB
  // settings: after it ran once, `favorites:config` is gone and bb.settings
  // alone governs pinToTop (M13).
  const legacyConfig = await bb.storage.kv.get<{ pinToTop?: boolean }>(
    LEGACY_CONFIG_KEY
  );
  if (legacyConfig && typeof legacyConfig === "object") {
    const updates: { pinToTop?: boolean } = {};
    if (typeof legacyConfig.pinToTop === "boolean") updates.pinToTop = legacyConfig.pinToTop;
    if (Object.keys(updates).length > 0) {
      try {
        await settings.experimental_set(updates);
        await bb.storage.kv.delete(LEGACY_CONFIG_KEY);
      } catch (err) {
        bb.log.info(`Could not migrate legacy config into settings: ${String(err)}`);
      }
    }
  }

  // Register RPC Handlers
  bb.rpc.register(rpcContract, {
    getFavorites: async () => withConfig(await readStore(await loadProviders())),

    addFavorite: async ({ providerId, modelId, label }) => {
      const directory = await loadProviders();
      const prov = normalizeProviderId(providerId, directory);
      const id = normalizeModelKey(modelId);
      if (prov === "default" || !id) return withConfig(await readStore(directory));
      return withConfig(await writeStore(directory, (s) => addModel(s, prov, id, label)));
    },

    removeFavorite: async ({ providerId, modelId }) => {
      const directory = await loadProviders();
      const prov = normalizeProviderId(providerId, directory);
      const id = normalizeModelKey(modelId);
      return withConfig(await writeStore(directory, (s) => removeModel(s, prov, id)));
    },

    toggleFavorite: async ({ providerId, modelId, label }) => {
      const directory = await loadProviders();
      const prov = normalizeProviderId(providerId, directory);
      const id = normalizeModelKey(modelId);
      if (prov === "default" || !id) {
        return { ...await withConfig(await readStore(directory)), isFavorite: false };
      }
      const next = await writeStore(directory, (s) => {
        if (s.favorites[prov]?.includes(id)) removeModel(s, prov, id);
        else addModel(s, prov, id, label);
      });
      return { ...await withConfig(next), isFavorite: next.favorites[prov]?.includes(id) ?? false };
    },

    setFavorites: async ({ favorites, modelLabels, baseVersion }) => {
      const directory = await loadProviders();
      const sanitized = sanitizeStore(favorites, modelLabels ?? {}, directory);
      const next = await writeStore(directory, (s) => {
        if (s.version !== baseVersion) {
          // BB 0.49 recognizes this refusal marker and maps conflict to HTTP 409.
          // The installed SDK 0.4.87 does not export its constructor.
          throw Object.assign(new Error("Favorites changed on the server"), {
            [Symbol.for("@get-bb/plugin-sdk/rpc-refusal")]: true,
            code: "conflict",
          });
        }
        s.favorites = sanitized.favorites;
        if (modelLabels !== undefined) {
          s.modelLabels = sanitized.modelLabels;
        } else {
          s.modelLabels = Object.fromEntries(
            Object.entries(s.modelLabels).filter(([key]) => {
              const idx = key.indexOf(":");
              return sanitized.favorites[key.slice(0, idx)]?.includes(key.slice(idx + 1));
            })
          );
        }
      });
      return withConfig(next);
    },

    clearFavorites: async ({ providerId }) => {
      const directory = await loadProviders();
      const prov = providerId ? normalizeProviderId(providerId, directory) : null;
      const next = await writeStore(directory, (s) => {
        if (prov) {
          delete s.favorites[prov];
          s.modelLabels = dropLabels(s.modelLabels, prov);
        } else {
          s.favorites = {};
          s.modelLabels = {};
        }
      });
      return withConfig(next);
    },

    updateConfig: async (updates) => {
      const clean: { pinToTop?: boolean } = {};
      if (typeof updates.pinToTop === "boolean") clean.pinToTop = updates.pinToTop;
      if (Object.keys(clean).length > 0) {
        try {
          await settings.experimental_set(clean);
        } catch (err) {
          bb.log.info(`settings write failed: ${String(err)}`);
          return { success: false, config: await getConfig() };
        }
      }
      return { success: true, config: await getConfig() };
    },
  });

  // Register CLI Command `bb favorites`
  bb.cli.register({
    name: "favorites",
    summary: "Manage favorite models for providers (list, add, remove, clear, export, doctor)",
    async run(argv, _ctx) {
      const [cmd, arg1, arg2] = argv;
      if (cmd === "doctor") {
        if ((arg1 !== undefined && arg1 !== "--fix") || arg2 !== undefined) {
          return { exitCode: 1, stderr: "Usage: bb favorites doctor [--fix]\n" };
        }
        const fix = arg1 === "--fix";
        const directory = await fetchProviderCatalog().catch(() => []);
        if (!directory.length) {
          return { exitCode: 1, stderr: "Could not verify the BB provider directory.\n" };
        }
        return withStoreLock(async () => {
          const before = await loadOrMigrate(directory, fix);
          const { findings, favorites, modelLabels } = inspectFavorites(before, directory);
          const changed = JSON.stringify(favorites) !== JSON.stringify(before.favorites) ||
            JSON.stringify(modelLabels) !== JSON.stringify(before.modelLabels);
          if (fix && changed) {
            await bb.storage.kv.set(STORE_KEY, { version: before.version + 1, favorites, modelLabels });
          }
          const lines = findings.length ? findings : ["No favorites issues found."];
          if (fix && changed) lines.push("Repairs applied.");
          return { exitCode: 0, stdout: lines.join("\n") + "\n" };
        });
      }

      const directory = await loadProviders();

      if (!cmd || cmd === "list" || cmd === "ls") {
        const { favorites } = await readStore(directory);
        const entries = Object.entries(favorites);
        if (entries.length === 0) {
          return {
            exitCode: 0,
            stdout: "No favorite models saved yet. Star models in the UI or use: bb favorites add <provider> <model>\n",
          };
        }

        let out = "⭐ Favorite Models:\n";
        for (const [prov, models] of entries) {
          out += `  [${prov}]\n`;
          for (const m of models) {
            out += `    - ${m}\n`;
          }
        }
        return { exitCode: 0, stdout: out };
      }

      if (cmd === "add") {
        if (!arg1 || !arg2) {
          return {
            exitCode: 1,
            stderr: "Usage: bb favorites add <provider> <model>\n",
          };
        }
        const prov = normalizeProviderId(arg1, directory);
        const id = normalizeModelKey(arg2);
        if (prov === "default" || !id) {
          return { exitCode: 1, stderr: `Could not resolve provider '${arg1}'.\n` };
        }
        await writeStore(directory, (s) => addModel(s, prov, id));
        return {
          exitCode: 0,
          stdout: `Added ${id} to favorites for provider '${prov}'.\n`,
        };
      }

      if (cmd === "remove" || cmd === "rm") {
        if (!arg1 || !arg2) {
          return {
            exitCode: 1,
            stderr: "Usage: bb favorites remove <provider> <model>\n",
          };
        }
        // Same canonical key the store is written under — a raw alias like
        // "openai" must resolve to "codex" before the lookup (m1), and the
        // model id gets the same cleaning the write path applies (m3).
        const prov = normalizeProviderId(arg1, directory);
        const id = normalizeModelKey(arg2);
        const before = await readStore(directory);
        const list = before.favorites[prov] || [];
        if (!list.includes(id)) {
          return {
            exitCode: 1,
            stderr: `Model '${id}' is not in favorites for provider '${prov}'.\n`,
          };
        }
        await writeStore(directory, (s) => removeModel(s, prov, id));
        return {
          exitCode: 0,
          stdout: `Removed ${id} from favorites for provider '${prov}'.\n`,
        };
      }

      if (cmd === "clear") {
        if (arg1) {
          const prov = normalizeProviderId(arg1, directory);
          const before = await readStore(directory);
          if (!before.favorites[prov]?.length) {
            return {
              exitCode: 1,
              stderr: `No favorites saved for provider '${prov}'.\n`,
            };
          }
          await writeStore(directory, (s) => {
            delete s.favorites[prov];
            s.modelLabels = dropLabels(s.modelLabels, prov);
          });
          return {
            exitCode: 0,
            stdout: `Cleared favorites for provider '${prov}'.\n`,
          };
        }
        await writeStore(directory, (s) => {
          s.favorites = {};
          s.modelLabels = {};
        });
        return {
          exitCode: 0,
          stdout: "Cleared all favorite models.\n",
        };
      }

      if (cmd === "export" || cmd === "json") {
        const snapshot = await readStore(directory);
        // Same wrapper shape the UI importer validates, so `bb favorites
        // export` output can be pasted straight into the settings field (m2).
        return {
          exitCode: 0,
          stdout:
            JSON.stringify(
              {
                version: snapshot.version,
                exportedAt: new Date().toISOString(),
                favorites: snapshot.favorites,
                modelLabels: snapshot.modelLabels,
              },
              null,
              2
            ) + "\n",
        };
      }

      return {
        exitCode: 1,
        stderr: `Unknown subcommand '${cmd}'. Commands: list, add <prov> <model>, remove <prov> <model>, clear [prov], export, doctor [--fix]\n`,
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("bb-plugin-favorite-models disposed");
  });
}
