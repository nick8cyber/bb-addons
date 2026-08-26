/**
 * The plugin's `bb.host` entry. Everything that touches the filesystem or the
 * gateways runs here, in the daemon worker on the execution host — that is the
 * only place where the credential stores and pi's models.json actually live.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

import {
  GATEWAYS,
  MODELS_JSON,
  buildProviderBlock,
  dropProviders,
  fetchCatalogue,
  fetchModelCatalogue,
  mergeProviders,
  selectFreeModels,
  type ProviderBlock,
} from "./src/gateways.js";
import { installReaders } from "./src/readers.js";
import { contractSchemas } from "./src/contract.js";
import { writeFileAtomic } from "./src/fsutil.js";
import {
  buildKeyRef,
  discoverReservedProviderIds,
  isCustomDef,
  loadManifest,
  normalizeBaseUrl,
  probeEndpoint,
  resolveToken,
  saveManifest,
  selectModelsForSave,
  validateCustomId,
  type CustomEndpointDef,
} from "./src/custom.js";

const gatewayReport = contractSchemas.status.output.shape.gateways.element;

function readModelsJson(): Record<string, unknown> | null {
  if (!existsSync(MODELS_JSON)) return null;
  try {
    return JSON.parse(readFileSync(MODELS_JSON, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`${MODELS_JSON} is not valid JSON, refusing to touch it`, { cause });
  }
}

function providersOf(file: Record<string, unknown> | null): Record<string, unknown> {
  return (file?.providers as Record<string, unknown>) ?? {};
}

/** Ask a reader for its token without ever returning the value. */
function tokenFor(readerPath: string): string | null {
  try {
    const token = execFileSync(process.execPath, [readerPath], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export default experimental_defineHostEntry({
  contract: contractSchemas,

  handlers: {
    status: async (_input, context) => {
      const readers = installReaders(context.experimental_paths.dataDir);
      const file = readModelsJson();
      const providers = providersOf(file);
      return {
        modelsJsonPath: MODELS_JSON,
        gateways: GATEWAYS.map((gateway) => {
          const block = providers[gateway.id] as ProviderBlock | undefined;
          return {
            id: gateway.id,
            label: gateway.label,
            credentialFound: tokenFor(readers[gateway.reader]!) !== null,
            inModelsJson: block !== undefined,
            modelCount: Array.isArray(block?.models) ? block.models.length : 0,
          };
        }),
      };
    },

    refresh: async (input, context) => {
      const readers = installReaders(context.experimental_paths.dataDir);
      const wanted = input.only?.length
        ? GATEWAYS.filter((gateway) => input.only!.includes(gateway.id))
        : GATEWAYS;

      const blocks: Record<string, ProviderBlock> = {};
      const reports: z.infer<typeof gatewayReport>[] = [];

      for (const gateway of wanted) {
        const readerPath = readers[gateway.reader]!;
        const token = tokenFor(readerPath);
        if (token === null) {
          reports.push({
            id: gateway.id,
            label: gateway.label,
            credentialFound: false,
            inModelsJson: false,
            modelCount: 0,
            error: `no credential found — sign in with the ${gateway.label} CLI first`,
          });
          continue;
        }
        try {
          const models = selectFreeModels(
            await fetchCatalogue(gateway, token, context.signal),
          );
          if (models.length === 0) {
            reports.push({
              id: gateway.id,
              label: gateway.label,
              credentialFound: true,
              inModelsJson: false,
              modelCount: 0,
              error: "the catalogue currently lists no zero-priced model",
            });
            continue;
          }
          blocks[gateway.id] = buildProviderBlock(gateway, readerPath, models);
          reports.push({
            id: gateway.id,
            label: gateway.label,
            credentialFound: true,
            inModelsJson: true,
            modelCount: models.length,
          });
        } catch (error) {
          reports.push({
            id: gateway.id,
            label: gateway.label,
            credentialFound: true,
            inModelsJson: false,
            modelCount: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let backupPath: string | undefined;
      if (Object.keys(blocks).length > 0) {
        if (existsSync(MODELS_JSON)) {
          backupPath = `${MODELS_JSON}.bak-pi-gateways`;
          copyFileSync(MODELS_JSON, backupPath);
        }
        const merged = mergeProviders(readModelsJson(), blocks);
        writeFileAtomic(MODELS_JSON, `${JSON.stringify(merged, null, 2)}\n`);
      }
      return { modelsJsonPath: MODELS_JSON, backupPath, gateways: reports };
    },

    remove: async () => {
      const { next, removed } = dropProviders(
        readModelsJson(),
        GATEWAYS.map((gateway) => gateway.id),
      );
      let backupPath: string | undefined;
      if (removed.length > 0) {
        backupPath = existsSync(MODELS_JSON) ? `${MODELS_JSON}.bak-pi-gateways` : undefined;
        if (backupPath) copyFileSync(MODELS_JSON, backupPath);
        writeFileAtomic(MODELS_JSON, `${JSON.stringify(next, null, 2)}\n`);
      }
      return { removed, backupPath };
    },

    reservedIds: async () => discoverReservedProviderIds(),

    probe: async (input, context) => probeEndpoint(input, context.signal),

    saveCustom: async (input, context) => {
      const dataDir = context.experimental_paths.dataDir;

      // Discovery failure means we cannot prove the id is safe to use: refuse
      // rather than silently allow a collision that would flood the picker.
      const reserved = discoverReservedProviderIds();
      if (!reserved.complete) {
        throw new Error(
          `could not locate pi's bundled provider catalogue (${reserved.source}); refusing to guess whether "${input.id}" collides`,
        );
      }

      // Refuse bad ids before touching credentials or the network.
      const manifest = loadManifest(dataDir);
      const reason = validateCustomId(input.id, {
        reserved: new Set(reserved.ids),
        presentInModelsJson: providersOf(readModelsJson())[input.id] !== undefined,
        ownedIds: new Set(Object.keys(manifest.owned)),
      });
      if (reason) throw new Error(reason);

      const keyRef = buildKeyRef(dataDir, input.keySource);

      const credentials = resolveToken(input.keySource);
      if (!credentials.ok) throw new Error(credentials.error);

      const catalogue = await fetchModelCatalogue({
        baseUrl: input.baseUrl,
        label: input.name,
        api: input.api,
        token: credentials.token,
        signal: context.signal,
      });

      const def: CustomEndpointDef = {
        id: input.id,
        name: input.name,
        baseUrl: normalizeBaseUrl(input.baseUrl),
        api: input.api,
        keySource: input.keySource,
        keyRef,
        freeOnly: input.freeOnly,
        selectionMode: input.selectionMode,
        selectedModelIds: input.selectedModelIds,
      };

      const models = selectModelsForSave(catalogue.entries, def);

      if (existsSync(MODELS_JSON)) copyFileSync(MODELS_JSON, `${MODELS_JSON}.bak-pi-gateways`);
      const merged = mergeProviders(readModelsJson(), {
        [def.id]: { name: def.name, baseUrl: def.baseUrl, api: def.api, apiKey: def.keyRef, models },
      });
      writeFileAtomic(MODELS_JSON, `${JSON.stringify(merged, null, 2)}\n`);

      try {
        const next = loadManifest(dataDir);
        next.owned[def.id] = def;
        saveManifest(dataDir, next);
      } catch (error) {
        // models.json already carries the new block; say so, because a retry
        // of the same save is what repairs ownership recording.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`saved into models.json but could not update the plugin manifest (${detail}); run the same save again`);
      }

      return {
        modelsJsonPath: MODELS_JSON,
        backupPath: existsSync(`${MODELS_JSON}.bak-pi-gateways`) ? `${MODELS_JSON}.bak-pi-gateways` : undefined,
        id: def.id,
        modelCount: models.length,
        warning: def.freeOnly
          ? undefined
          : "paid models were saved — every one of them can spend real money on this endpoint",
      };
    },

    refreshCustom: async (input, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const manifest = loadManifest(dataDir);
      const ids = input.ids?.length
        ? input.ids
        : Object.keys(manifest.owned).filter((id) => isCustomDef(manifest.owned[id]));

      const results: Array<{ id: string; ok: boolean; modelCount?: number; error?: string }> = [];
      let wroteAny = false;

      for (const id of ids) {
        const entry = manifest.owned[id];
        if (!isCustomDef(entry)) {
          results.push({
            id,
            ok: false,
            error: entry?.builtin ? "built-ins are refreshed by `bb pi-gateways refresh`" : "unknown endpoint",
          });
          continue;
        }
        try {
          const credentials = resolveToken(entry.keySource);
          if (!credentials.ok) throw new Error(credentials.error);
          const catalogue = await fetchModelCatalogue({
            baseUrl: entry.baseUrl,
            label: entry.name,
            api: entry.api,
            token: credentials.token,
            signal: context.signal,
          });
          const models = selectModelsForSave(catalogue.entries, entry);
          if (existsSync(MODELS_JSON)) copyFileSync(MODELS_JSON, `${MODELS_JSON}.bak-pi-gateways`);
          const merged = mergeProviders(readModelsJson(), {
            [id]: { name: entry.name, baseUrl: entry.baseUrl, api: entry.api, apiKey: entry.keyRef, models },
          });
          writeFileAtomic(MODELS_JSON, `${JSON.stringify(merged, null, 2)}\n`);
          wroteAny = true;
          results.push({ id, ok: true, modelCount: models.length });
        } catch (error) {
          results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      return {
        modelsJsonPath: MODELS_JSON,
        backupPath: wroteAny && existsSync(`${MODELS_JSON}.bak-pi-gateways`) ? `${MODELS_JSON}.bak-pi-gateways` : undefined,
        results,
      };
    },

    deleteCustom: async (input, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const manifest = loadManifest(dataDir);
      const entry = manifest.owned[input.id];
      if (!entry) throw new Error(`"${input.id}" is not a known endpoint`);
      if (!isCustomDef(entry)) {
        throw new Error("built-in gateways are managed by `bb pi-gateways remove`, not deleted here");
      }

      const { next, removed } = dropProviders(readModelsJson(), [input.id]);
      let backupPath: string | undefined;
      if (removed.length > 0) {
        backupPath = existsSync(MODELS_JSON) ? `${MODELS_JSON}.bak-pi-gateways` : undefined;
        if (backupPath) copyFileSync(MODELS_JSON, backupPath);
        writeFileAtomic(MODELS_JSON, `${JSON.stringify(next, null, 2)}\n`);
      }

      const nextManifest = loadManifest(dataDir);
      delete nextManifest.owned[input.id];
      saveManifest(dataDir, nextManifest);

      return { removed, backupPath };
    },

    listCustom: async (_input, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const manifest = loadManifest(dataDir);
      const providers = providersOf(readModelsJson());
      return {
        modelsJsonPath: MODELS_JSON,
        endpoints: Object.entries(manifest.owned)
          .filter(([, entry]) => isCustomDef(entry))
          .map(([id, entry]) => ({ ...entry, id }))
          .filter((def): def is CustomEndpointDef => isCustomDef(def))
          .map((def) => {
            const block = providers[def.id] as ProviderBlock | undefined;
            return {
              id: def.id,
              name: def.name,
              baseUrl: def.baseUrl,
              api: def.api,
              keyRef: def.keyRef,
              freeOnly: def.freeOnly,
              selectionMode: def.selectionMode,
              inModelsJson: block !== undefined,
              modelCount: Array.isArray(block?.models) ? block.models.length : 0,
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    },
  },
});

