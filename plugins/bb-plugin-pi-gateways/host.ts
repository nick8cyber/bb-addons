/**
 * The plugin's `bb.host` entry. Everything that touches the filesystem or the
 * gateways runs here, in the daemon worker on the execution host — that is the
 * only place where the credential stores and pi's models.json actually live.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

import {
  GATEWAYS,
  MODELS_JSON,
  buildProviderBlock,
  dropProviders,
  fetchCatalogue,
  mergeProviders,
  selectFreeModels,
  type ProviderBlock,
} from "./src/gateways.js";
import { installReaders } from "./src/readers.js";

const gatewayReport = z.object({
  id: z.string(),
  label: z.string(),
  credentialFound: z.boolean(),
  inModelsJson: z.boolean(),
  modelCount: z.number(),
  error: z.string().optional(),
});

function readModelsJson(): Record<string, unknown> | null {
  if (!existsSync(MODELS_JSON)) return null;
  try {
    return JSON.parse(readFileSync(MODELS_JSON, "utf8")) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`${MODELS_JSON} is not valid JSON, refusing to touch it`, { cause });
  }
}

/** Back the file up before every write; a bad merge must never be one-way. */
function writeModelsJson(next: Record<string, unknown>): string | undefined {
  let backup: string | undefined;
  if (existsSync(MODELS_JSON)) {
    backup = `${MODELS_JSON}.bak-pi-gateways`;
    copyFileSync(MODELS_JSON, backup);
  }
  mkdirSync(dirname(MODELS_JSON), { recursive: true });
  writeFileSync(MODELS_JSON, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return backup;
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

function providersOf(file: Record<string, unknown> | null): Record<string, unknown> {
  return (file?.providers as Record<string, unknown>) ?? {};
}

export default experimental_defineHostEntry({
  contract: {
    status: {
      input: z.object({}),
      output: z.object({
        modelsJsonPath: z.string(),
        gateways: z.array(gatewayReport),
      }),
    },
    refresh: {
      input: z.object({ only: z.array(z.string()).optional() }),
      output: z.object({
        modelsJsonPath: z.string(),
        backupPath: z.string().optional(),
        gateways: z.array(gatewayReport),
      }),
    },
    remove: {
      input: z.object({}),
      output: z.object({ removed: z.array(z.string()), backupPath: z.string().optional() }),
    },
  },

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
        const merged = mergeProviders(readModelsJson(), blocks);
        backupPath = writeModelsJson(merged);
      }
      return { modelsJsonPath: MODELS_JSON, backupPath, gateways: reports };
    },

    remove: async () => {
      const { next, removed } = dropProviders(
        readModelsJson(),
        GATEWAYS.map((gateway) => gateway.id),
      );
      const backupPath = removed.length > 0 ? writeModelsJson(next) : undefined;
      return { removed, backupPath };
    },
  },
});
