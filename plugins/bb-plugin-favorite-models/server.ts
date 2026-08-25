/**
 * bb-plugin-favorite-models — Backend server entry.
 *
 * Implements persistent storage for favorite models, RPC data plane, and CLI commands.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  getFavorites: {
    input: z.null(),
    output: z.object({
      favorites: z.record(z.string(), z.array(z.string())),
      modelLabels: z.record(z.string(), z.string()),
      config: z.object({
        pinToTop: z.boolean(),
        showQuickBar: z.boolean(),
      }),
    }),
  },
  toggleFavorite: {
    input: z.object({
      providerId: z.string(),
      modelId: z.string(),
      label: z.string().optional(),
    }),
    output: z.object({
      isFavorite: z.boolean(),
      favorites: z.record(z.string(), z.array(z.string())),
    }),
  },
  setFavorites: {
    input: z.object({
      favorites: z.record(z.string(), z.array(z.string())),
      modelLabels: z.record(z.string(), z.string()).optional(),
    }),
    output: z.object({
      success: z.boolean(),
    }),
  },
  clearFavorites: {
    input: z.object({
      providerId: z.string().nullable().optional(),
    }),
    output: z.object({
      success: z.boolean(),
    }),
  },
  updateConfig: {
    input: z.object({
      pinToTop: z.boolean().optional(),
      showQuickBar: z.boolean().optional(),
    }),
    output: z.object({
      success: z.boolean(),
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

  function cleanProviderId(providerId: string): string {
    let clean = (providerId || "").toLowerCase().trim();
    if (
      clean.includes("⌘") ||
      clean.includes("⇧") ||
      clean.includes("alt") ||
      clean.includes("ctrl") ||
      clean.includes("shift")
    ) {
      return "provider-claude-code";
    }
    if (clean.includes("codex") || clean === "openai") return "codex";
    if (clean.includes("claude") || clean === "anthropic") return "provider-claude-code";
    if (clean.includes("antigravity") || clean === "agy" || clean.includes("gemini")) return "agy";
    if (clean.includes("pi")) return "provider-pi";
    return clean.replace(/\s+/g, "-");
  }

  function sanitizeFavoritesStore(raw: Record<string, string[]>): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [key, models] of Object.entries(raw || {})) {
      if (!Array.isArray(models) || models.length === 0) continue;
      const cleanProv = cleanProviderId(key);
      const existing = result[cleanProv] || [];
      for (const m of models) {
        if (typeof m === "string" && m.trim() && !existing.includes(m.trim())) {
          existing.push(m.trim());
        }
      }
      result[cleanProv] = existing;
    }
    return result;
  }

  const getFavoritesStore = async (): Promise<Record<string, string[]>> => {
    const raw = (await bb.storage.kv.get<Record<string, string[]>>("favorites:map")) ?? {};
    const sanitized = sanitizeFavoritesStore(raw);
    if (JSON.stringify(raw) !== JSON.stringify(sanitized)) {
      await bb.storage.kv.set("favorites:map", sanitized);
    }
    return sanitized;
  };

  const getConfigStore = async () => {
    const s = await settings.get();
    const kvConfig = (await bb.storage.kv.get<{ pinToTop?: boolean; showQuickBar?: boolean }>("favorites:config")) ?? {};
    return {
      pinToTop: kvConfig.pinToTop ?? s.pinToTop ?? true,
      showQuickBar: kvConfig.showQuickBar ?? s.showQuickBar ?? true,
    };
  };

  // Register RPC Handlers
  bb.rpc.register(rpcContract, {
    getFavorites: async () => {
      const favorites = await getFavoritesStore();
      const modelLabels = (await bb.storage.kv.get<Record<string, string>>("favorites:labels")) ?? {};
      const config = await getConfigStore();
      return { favorites, modelLabels, config };
    },

    toggleFavorite: async ({ providerId, modelId, label }) => {
      const cleanProv = cleanProviderId(providerId);
      const favorites = await getFavoritesStore();
      const modelLabels = (await bb.storage.kv.get<Record<string, string>>("favorites:labels")) ?? {};

      const list = favorites[cleanProv] || [];
      const exists = list.includes(modelId);

      let nextList: string[];
      if (exists) {
        nextList = list.filter((id) => id !== modelId);
      } else {
        nextList = [modelId, ...list.filter((id) => id !== modelId)];
      }

      if (nextList.length === 0) {
        delete favorites[cleanProv];
      } else {
        favorites[cleanProv] = nextList;
      }

      if (label) {
        modelLabels[`${cleanProv}:${modelId}`] = label;
        await bb.storage.kv.set("favorites:labels", modelLabels);
      }

      await bb.storage.kv.set("favorites:map", favorites);
      bb.log.info(`Favorite toggled: ${cleanProv}/${modelId} -> ${!exists}`);

      return {
        isFavorite: !exists,
        favorites,
      };
    },

    setFavorites: async ({ favorites, modelLabels }) => {
      const sanitized = sanitizeFavoritesStore(favorites);
      await bb.storage.kv.set("favorites:map", sanitized);
      if (modelLabels) {
        await bb.storage.kv.set("favorites:labels", modelLabels);
      }
      return { success: true };
    },

    clearFavorites: async ({ providerId }) => {
      if (providerId) {
        const favorites = await getFavoritesStore();
        delete favorites[providerId];
        await bb.storage.kv.set("favorites:map", favorites);
      } else {
        await bb.storage.kv.set("favorites:map", {});
      }
      return { success: true };
    },

    updateConfig: async (updates) => {
      const current = await getConfigStore();
      const next = { ...current, ...updates };
      await bb.storage.kv.set("favorites:config", next);
      return { success: true };
    },
  });

  // Register CLI Command `bb favorites`
  bb.cli.register({
    name: "favorites",
    summary: "Manage favorite models for providers (list, add, remove, clear)",
    async run(argv, _ctx) {
      const [cmd, arg1, arg2] = argv;

      if (!cmd || cmd === "list" || cmd === "ls") {
        const favorites = await getFavoritesStore();
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
        const favorites = await getFavoritesStore();
        const list = favorites[arg1] || [];
        if (!list.includes(arg2)) {
          favorites[arg1] = [arg2, ...list];
          await bb.storage.kv.set("favorites:map", favorites);
        }
        return {
          exitCode: 0,
          stdout: `Added ${arg2} to favorites for provider '${arg1}'.\n`,
        };
      }

      if (cmd === "remove" || cmd === "rm") {
        if (!arg1 || !arg2) {
          return {
            exitCode: 1,
            stderr: "Usage: bb favorites remove <provider> <model>\n",
          };
        }
        const favorites = await getFavoritesStore();
        const list = favorites[arg1] || [];
        favorites[arg1] = list.filter((m) => m !== arg2);
        if (favorites[arg1].length === 0) {
          delete favorites[arg1];
        }
        await bb.storage.kv.set("favorites:map", favorites);
        return {
          exitCode: 0,
          stdout: `Removed ${arg2} from favorites for provider '${arg1}'.\n`,
        };
      }

      if (cmd === "clear") {
        if (arg1) {
          const favorites = await getFavoritesStore();
          delete favorites[arg1];
          await bb.storage.kv.set("favorites:map", favorites);
          return {
            exitCode: 0,
            stdout: `Cleared favorites for provider '${arg1}'.\n`,
          };
        } else {
          await bb.storage.kv.set("favorites:map", {});
          return {
            exitCode: 0,
            stdout: "Cleared all favorite models.\n",
          };
        }
      }

      if (cmd === "export" || cmd === "json") {
        const favorites = await getFavoritesStore();
        return {
          exitCode: 0,
          stdout: JSON.stringify(favorites, null, 2) + "\n",
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
