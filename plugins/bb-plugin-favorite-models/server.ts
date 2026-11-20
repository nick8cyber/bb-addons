/**
 * bb-plugin-favorite-models — Backend server entry.
 *
 * Implements persistent storage for favorite models, RPC data plane, and CLI commands.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  cleanModelText,
  dropLabels,
  labelKey,
  normalizeProviderId,
  sanitizeStore,
  type FavoritesMap,
  type FavoritesSnapshot,
  type ModelLabels,
} from "./src/store.js";

const STORE_KEY = "favorites:store";
const LEGACY_MAP_KEY = "favorites:map";
const LEGACY_LABELS_KEY = "favorites:labels";
const LEGACY_CONFIG_KEY = "favorites:config";

const snapshotOutput = z.object({
  version: z.number(),
  favorites: z.record(z.string(), z.array(z.string())),
  modelLabels: z.record(z.string(), z.string()),
  config: z.object({
    pinToTop: z.boolean(),
    showQuickBar: z.boolean(),
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
  setFavorites: {
    input: z.object({
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
      showQuickBar: z.boolean().optional(),
    }),
    output: z.object({
      success: z.boolean(),
      config: z.object({
        pinToTop: z.boolean(),
        showQuickBar: z.boolean(),
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
    showQuickBar: {
      type: "boolean",
      label: "Show quick favorites in composer",
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

  /**
   * Load the store, migrating legacy split keys (`favorites:map`,
   * `favorites:labels`) into the single versioned record on first access.
   * Call ONLY inside withStoreLock — every reader and every writer (incl.
   * CLI paths that never call readStore first) goes through this, so a
   * first-write after upgrade can never overwrite the old split keys with
   * an empty snapshot.
   */
  const loadOrMigrate = async (): Promise<FavoritesSnapshot> => {
    const existing = await bb.storage.kv.get<FavoritesSnapshot>(STORE_KEY);
    if (existing && typeof existing === "object" && typeof existing.version === "number") {
      return existing;
    }
    const legacyMap = await bb.storage.kv.get<FavoritesMap>(LEGACY_MAP_KEY);
    const legacyLabels = await bb.storage.kv.get<ModelLabels>(LEGACY_LABELS_KEY);
    // Nothing stored anywhere: hand back an empty v0 without persisting —
    // the first real write becomes version 1 and no stray record appears
    // on fresh installs.
    if (legacyMap === undefined && legacyLabels === undefined) {
      return { version: 0, favorites: {}, modelLabels: {} };
    }
    const { favorites, modelLabels } = sanitizeStore(legacyMap ?? {}, legacyLabels ?? {});
    const snapshot: FavoritesSnapshot = { version: 1, favorites, modelLabels };
    await bb.storage.kv.set(STORE_KEY, snapshot);
    await bb.storage.kv.delete(LEGACY_MAP_KEY);
    await bb.storage.kv.delete(LEGACY_LABELS_KEY);
    return snapshot;
  };

  const readStore = (): Promise<FavoritesSnapshot> => withStoreLock(loadOrMigrate);

  const writeStore = (
    mutate: (snapshot: FavoritesSnapshot) => void
  ): Promise<FavoritesSnapshot> =>
    withStoreLock(async () => {
      const existing = await loadOrMigrate();
      const snapshot: FavoritesSnapshot = {
        ...existing,
        favorites: { ...existing.favorites },
        modelLabels: { ...existing.modelLabels },
      };
      mutate(snapshot);
      const { favorites, modelLabels } = sanitizeStore(snapshot.favorites, snapshot.modelLabels);
      const next: FavoritesSnapshot = {
        version: snapshot.version + 1,
        favorites,
        modelLabels,
      };
      await bb.storage.kv.set(STORE_KEY, next);
      return next;
    });

  const getConfig = async () => {
    const s = await settings.get();
    return {
      pinToTop: s.pinToTop ?? true,
      showQuickBar: s.showQuickBar ?? true,
    };
  };

  const withConfig = async (snapshot: FavoritesSnapshot) => ({
    ...snapshot,
    config: await getConfig(),
  });

  // One-off migration of the pre-refactor KV config override into real BB
  // settings: after it ran once, `favorites:config` is gone and bb.settings
  // alone governs pinToTop/showQuickBar (M13).
  const legacyConfig = await bb.storage.kv.get<{ pinToTop?: boolean; showQuickBar?: boolean }>(
    LEGACY_CONFIG_KEY
  );
  if (legacyConfig && typeof legacyConfig === "object") {
    const updates: { pinToTop?: boolean; showQuickBar?: boolean } = {};
    if (typeof legacyConfig.pinToTop === "boolean") updates.pinToTop = legacyConfig.pinToTop;
    if (typeof legacyConfig.showQuickBar === "boolean") updates.showQuickBar = legacyConfig.showQuickBar;
    if (Object.keys(updates).length > 0) {
      try {
        await settings.experimental_set(updates);
      } catch (err) {
        bb.log.info(`Could not migrate legacy config into settings: ${String(err)}`);
      }
    }
    await bb.storage.kv.delete(LEGACY_CONFIG_KEY);
  }

  // Register RPC Handlers
  bb.rpc.register(rpcContract, {
    getFavorites: async () => withConfig(await readStore()),

    addFavorite: async ({ providerId, modelId, label }) => {
      const prov = normalizeProviderId(providerId);
      const id = modelId.trim();
      if (!prov || prov === "default" || !id) return withConfig(await readStore());
      const next = await writeStore((s) => {
        const list = s.favorites[prov] || [];
        s.favorites[prov] = list.includes(id) ? list : [id, ...list];
        if (label) s.modelLabels[labelKey(prov, id)] = label;
      });
      bb.log.info(`Favorite added: ${prov}/${id}`);
      return withConfig(next);
    },

    removeFavorite: async ({ providerId, modelId }) => {
      const prov = normalizeProviderId(providerId);
      // Stored ids are sanitized on write; the lookup key must go through
      // the same cleaning or "model ⌘M"-style residue makes records
      // unremovable.
      const id = cleanModelText(modelId.trim());
      const next = await writeStore((s) => {
        const list = s.favorites[prov] || [];
        const rest = list.filter((m) => m !== id);
        if (rest.length === 0) delete s.favorites[prov];
        else s.favorites[prov] = rest;
        s.modelLabels = dropLabels(s.modelLabels, prov, id);
      });
      bb.log.info(`Favorite removed: ${prov}/${id}`);
      return withConfig(next);
    },

    setFavorites: async ({ favorites, modelLabels }) => {
      const sanitized = sanitizeStore(favorites, modelLabels ?? {});
      const next = await writeStore((s) => {
        s.favorites = sanitized.favorites;
        if (modelLabels !== undefined) {
          s.modelLabels = sanitized.modelLabels;
        } else {
          // Keep only labels that still point at a favorited model.
          s.modelLabels = Object.fromEntries(
            Object.entries(s.modelLabels).filter(([key]) => {
              const idx = key.indexOf(":");
              const list = sanitized.favorites[key.slice(0, idx)];
              return Array.isArray(list) && list.includes(key.slice(idx + 1));
            })
          );
        }
      });
      return withConfig(next);
    },

    clearFavorites: async ({ providerId }) => {
      const prov = providerId ? normalizeProviderId(providerId) : null;
      const next = await writeStore((s) => {
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
      const clean: { pinToTop?: boolean; showQuickBar?: boolean } = {};
      if (typeof updates.pinToTop === "boolean") clean.pinToTop = updates.pinToTop;
      if (typeof updates.showQuickBar === "boolean") clean.showQuickBar = updates.showQuickBar;
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
    summary: "Manage favorite models for providers (list, add, remove, clear)",
    async run(argv, _ctx) {
      const [cmd, arg1, arg2] = argv;

      if (!cmd || cmd === "list" || cmd === "ls") {
        const { favorites } = await readStore();
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
        const prov = normalizeProviderId(arg1);
        const id = arg2.trim();
        if (prov === "default" || !id) {
          return { exitCode: 1, stderr: `Could not resolve provider '${arg1}'.\n` };
        }
        await writeStore((s) => {
          const list = s.favorites[prov] || [];
          if (!list.includes(id)) s.favorites[prov] = [id, ...list];
        });
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
        const prov = normalizeProviderId(arg1);
        const id = cleanModelText(arg2.trim());
        const before = await readStore();
        const list = before.favorites[prov] || [];
        if (!list.includes(id)) {
          return {
            exitCode: 1,
            stderr: `Model '${id}' is not in favorites for provider '${prov}'.\n`,
          };
        }
        await writeStore((s) => {
          const rest = (s.favorites[prov] || []).filter((m) => m !== id);
          if (rest.length === 0) delete s.favorites[prov];
          else s.favorites[prov] = rest;
          s.modelLabels = dropLabels(s.modelLabels, prov, id);
        });
        return {
          exitCode: 0,
          stdout: `Removed ${id} from favorites for provider '${prov}'.\n`,
        };
      }

      if (cmd === "clear") {
        if (arg1) {
          const prov = normalizeProviderId(arg1);
          const before = await readStore();
          if (!before.favorites[prov]?.length) {
            return {
              exitCode: 1,
              stderr: `No favorites saved for provider '${prov}'.\n`,
            };
          }
          await writeStore((s) => {
            delete s.favorites[prov];
            s.modelLabels = dropLabels(s.modelLabels, prov);
          });
          return {
            exitCode: 0,
            stdout: `Cleared favorites for provider '${prov}'.\n`,
          };
        }
        await writeStore((s) => {
          s.favorites = {};
          s.modelLabels = {};
        });
        return {
          exitCode: 0,
          stdout: "Cleared all favorite models.\n",
        };
      }

      if (cmd === "export" || cmd === "json") {
        const snapshot = await readStore();
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
        stderr: `Unknown subcommand '${cmd}'. Commands: list, add <prov> <model>, remove <prov> <model>, clear [prov], export\n`,
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("bb-plugin-favorite-models disposed");
  });
}
