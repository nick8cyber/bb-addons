/**
 * The plugin's `bb.host` entry. Everything that touches the filesystem or the
 * gateways runs here, in the daemon worker on the execution host — that is the
 * only place where the credential stores and pi's models.json actually live.
 *
 * Two rules shape every handler below:
 *
 * 1. models.json has other writers. Every mutation goes through
 *    `updateModelsJson`, which serialises, detects concurrent writes, and keeps
 *    the exact bytes it replaced; and every write to a block we did not create
 *    merges onto the freshest parse instead of rebuilding it, so `headers`, an
 *    inline `apiKey`, and fields from future pi versions survive untouched.
 * 2. No credential value ever leaves this file. Keys are described by the
 *    redacted rendering in src/keyref.ts, resolved in memory when a request
 *    needs one, and never written to the manifest, an RPC response or an error.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

import {
  GATEWAYS,
  buildProviderBlock,
  dropProviders,
  fetchCatalogue,
  fetchModelCatalogue,
  mergeProviderBlock,
  mergeProviders,
  modelsJsonPath,
  selectFreeModels,
  type CatalogueEntry,
  type ModelEntry,
  type ModelsJson,
  type ProviderBlock,
} from "./src/gateways.js";
import { installReaders } from "./src/readers.js";
import {
  contractSchemas,
  type ApiKind,
  type ManifestKeySource,
  type PricingPolicy,
  type ProviderRow,
} from "./src/contract.js";
import { fingerprintValue, updateModelsJson } from "./src/fsutil.js";
import { keyRefWarnings, parseKeyRef } from "./src/keyref.js";
import {
  DRIFT_ERROR_SUFFIX,
  UNSUPPORTED_API_ERROR,
  asApiKind,
  buildKeyRef,
  deriveOwnership,
  discoverReservedProviderIds,
  disownProvider,
  effectivePricingPolicy,
  isBuiltinId,
  isCustomDef,
  isDrifted,
  keyRefDisplayFor,
  loadManifest,
  normalizeBaseUrl,
  planAdoption,
  probeEndpoint,
  resolveEntryToken,
  resolveToken,
  requiresExplicitModelSelection,
  saveManifest,
  selectModelsForSave,
  validateCustomId,
  type CustomEndpointDef,
  type OwnedEntry,
  type SelectionPolicy,
} from "./src/custom.js";
import { availableProviderId, findSavedProviderPreset } from "./src/presets.js";

const gatewayReport = contractSchemas.status.output.shape.gateways.element;

const BACKUP_PREFIX = "bak-pi-gateways";
const BACKUP_RETAIN = 10;

function readModelsJson(): ModelsJson | null {
  const path = modelsJsonPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ModelsJson;
  } catch (cause) {
    throw new Error(`${path} is not valid JSON, refusing to touch it`, { cause });
  }
}

function providersOf(file: ModelsJson | null): Record<string, unknown> {
  return (file?.providers as Record<string, unknown>) ?? {};
}

function blockOf(file: ModelsJson | null, id: string): Record<string, unknown> | undefined {
  const block = providersOf(file)[id];
  return block && typeof block === "object" && !Array.isArray(block)
    ? (block as Record<string, unknown>)
    : undefined;
}

function modelsOf(block: Record<string, unknown> | undefined): unknown[] {
  return Array.isArray(block?.models) ? (block!.models as unknown[]) : [];
}

function headerNamesOf(block: Record<string, unknown> | undefined): string[] {
  const headers = block?.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return [];
  return Object.keys(headers as Record<string, unknown>);
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

/** One block replacement or drop, applied to the freshest parse of the file. */
async function writeModelsJson(
  mutate: (file: ModelsJson | null) => { next: ModelsJson; changed: boolean },
): Promise<{ backupPath?: string; wrote: boolean }> {
  return updateModelsJson({
    path: modelsJsonPath(),
    backupPrefix: BACKUP_PREFIX,
    retain: BACKUP_RETAIN,
    mutate,
  });
}

function policyFor(entry: CustomEndpointDef, api: ApiKind): SelectionPolicy {
  const preset = entry.presetId ? findSavedProviderPreset(entry.presetId) : undefined;
  return {
    api,
    freeOnly: entry.freeOnly,
    selectionMode: entry.selectionMode,
    selectedModelIds: entry.selectedModelIds,
    pricingPolicy: entry.pricingPolicy ?? preset?.pricing,
    requiresExplicitModels: entry.requiresExplicitModels ?? preset?.requiresExplicitModels,
  };
}

/**
 * The block to write for a managed id.
 *
 * `created` entries get the exact five fields this plugin owns — nothing else
 * has ever been true of them. `adopted` entries are merged onto whatever is in
 * the file, and their credential fields are carried forward verbatim unless we
 * hold a reference of our own, because the value may be a literal we promised
 * never to copy.
 */
function blockForEntry(
  entry: CustomEndpointDef,
  live: Record<string, unknown> | undefined,
  models: ModelEntry[],
): Record<string, unknown> {
  const ours: Record<string, unknown> = {
    name: entry.name,
    baseUrl: entry.baseUrl,
    api: entry.api,
  };
  if (entry.keySource.type !== "inline") ours.apiKey = entry.keyRef;
  if (entry.origin === "created") {
    const block: Record<string, unknown> = { ...ours, models };
    return block;
  }
  return mergeProviderBlock(live, ours, models);
}

function rowFor(args: {
  id: string;
  entry: OwnedEntry | undefined;
  block: Record<string, unknown> | undefined;
  reserved: ReadonlySet<string>;
}): ProviderRow {
  const { id, block } = args;
  const entry = isCustomDef(args.entry) ? args.entry : undefined;
  const builtin = isBuiltinId(id);
  const ownership = deriveOwnership({
    id,
    entry: args.entry,
    inModelsJson: block !== undefined,
    reserved: args.reserved,
  });
  const gateway = GATEWAYS.find((candidate) => candidate.id === id);
  const api = typeof block?.api === "string" ? (block.api as string) : entry?.api;
  const key = keyRefDisplayFor(entry, block);
  const warnings: string[] = [];
  if (typeof block?.apiKey === "string") warnings.push(...keyRefWarnings(block.apiKey as string));
  if (api !== undefined && asApiKind(api) === undefined) {
    warnings.push(`api "${api}" is not a protocol this plugin can probe or refresh`);
  }
  if (ownership === "reserved") {
    warnings.push("pi ships its own catalogue under this id; the plugin will not manage it");
  }
  const drifted = entry !== undefined && isDrifted(entry, block);
  if (drifted) warnings.push("this provider changed in models.json after the plugin last wrote it");

  return {
    id,
    name: typeof block?.name === "string" ? (block.name as string) : entry?.name ?? gateway?.label,
    baseUrl: typeof block?.baseUrl === "string" ? (block.baseUrl as string) : entry?.baseUrl ?? gateway?.baseUrl,
    api,
    apiSupported: builtin ? true : asApiKind(api ?? "openai-completions") !== undefined,
    ownership,
    drifted,
    inModelsJson: block !== undefined,
    modelCount: modelsOf(block).length,
    keyRefKind: key.kind,
    keyRefDisplay: key.display,
    hasHeaders: headerNamesOf(block).length > 0,
    presetId: entry?.presetId,
    freeOnly: entry?.freeOnly,
    selectionMode: entry?.selectionMode,
    pricingPolicy: entry ? effectivePricingPolicy(entry) : undefined,
    requiresExplicitModels: entry ? requiresExplicitModelSelection(entry) : undefined,
    keySourceType: entry?.keySource.type,
    origin: entry?.origin,
    warnings,
    error:
      ownership === "orphaned"
        ? "recorded by this plugin but absent from models.json — refresh to write it again, or forget it"
        : undefined,
  };
}

function inventory(dataDir: string) {
  const manifest = loadManifest(dataDir);
  const file = readModelsJson();
  const providers = providersOf(file);
  const reservedDiscovery = discoverReservedProviderIds();
  const reserved = new Set(reservedDiscovery.ids);
  const ids = new Set<string>([
    ...GATEWAYS.map((gateway) => gateway.id),
    ...Object.keys(manifest.owned),
    ...Object.keys(providers),
  ]);
  return { manifest, file, providers, reserved, reservedDiscovery, ids };
}

function requireCompleteReserved(): void {
  const reserved = discoverReservedProviderIds();
  if (!reserved.complete) {
    throw new Error(
      `could not locate pi's bundled provider catalogue (${reserved.source}); refusing to guess whether the provider key collides`,
    );
  }
}

function requireManagedEntry(dataDir: string, id: string): { manifest: ReturnType<typeof loadManifest>; entry: CustomEndpointDef } {
  const manifest = loadManifest(dataDir);
  const entry = manifest.owned[id];
  if (!entry) throw new Error(`"${id}" is not managed by this plugin — adopt it first`);
  if (!isCustomDef(entry)) {
    throw new Error("built-in gateways are managed by `bb pi-gateways refresh` and `remove`");
  }
  return { manifest, entry };
}

/** Record the fingerprints of the blocks as they now stand, so drift can be seen later. */
function rememberFingerprints(dataDir: string, written: ReadonlyMap<string, unknown>): void {
  if (written.size === 0) return;
  const manifest = loadManifest(dataDir);
  const now = new Date().toISOString();
  for (const [id, block] of written) {
    const entry = manifest.owned[id];
    if (!isCustomDef(entry)) continue;
    entry.fingerprint = fingerprintValue(block);
    entry.updatedAt = now;
  }
  saveManifest(dataDir, manifest);
}

export default experimental_defineHostEntry({
  contract: contractSchemas,

  handlers: {
    status: async (_input, context) => {
      const readers = installReaders(context.experimental_paths.dataDir);
      const providers = providersOf(readModelsJson());
      return {
        modelsJsonPath: modelsJsonPath(),
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
          const models = selectFreeModels(await fetchCatalogue(gateway, token, context.signal));
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
        ({ backupPath } = await writeModelsJson((file) => ({
          next: mergeProviders(file, blocks),
          changed: true,
        })));
      }
      return { modelsJsonPath: modelsJsonPath(), backupPath, gateways: reports };
    },

    remove: async () => {
      let removed: string[] = [];
      const { backupPath } = await writeModelsJson((file) => {
        const result = dropProviders(file, GATEWAYS.map((gateway) => gateway.id));
        removed = result.removed;
        return { next: result.next, changed: result.removed.length > 0 };
      });
      return { removed, backupPath };
    },

    reservedIds: async () => discoverReservedProviderIds(),

    probe: async (input, context) => {
      const preset = input.presetId ? findSavedProviderPreset(input.presetId) : undefined;
      if (input.presetId && !preset) {
        throw new Error(`unknown provider preset "${input.presetId}"`);
      }

      let keySource: ManifestKeySource | undefined = input.keySource;
      let baseUrl = preset?.baseUrl ?? input.baseUrl;
      let api: string = preset?.api ?? input.api;
      let pricingPolicy: PricingPolicy | undefined = preset?.pricing;
      let requiresExplicitModels = preset?.requiresExplicitModels;
      let inlineToken: string | undefined;

      if (input.id) {
        // Testing a managed provider: borrow its credential rather than making
        // the user retype one, including when the key lives only in the file.
        const dataDir = context.experimental_paths.dataDir;
        const { entry } = requireManagedEntry(dataDir, input.id);
        const block = blockOf(readModelsJson(), input.id);
        baseUrl = input.baseUrl || entry.baseUrl;
        api = entry.api;
        pricingPolicy = pricingPolicy ?? entry.pricingPolicy;
        requiresExplicitModels = requiresExplicitModels ?? entry.requiresExplicitModels;
        if (entry.keySource.type === "inline") {
          const resolved = resolveEntryToken(entry, block);
          if (!resolved.ok) throw new Error(resolved.error);
          inlineToken = resolved.token;
        } else {
          keySource = entry.keySource;
        }
      }

      const apiKind = asApiKind(api);
      if (!apiKind) throw new Error(UNSUPPORTED_API_ERROR);
      if (!keySource && !inlineToken) {
        throw new Error("give a key source, or an id of a provider whose key should be reused");
      }

      return probeEndpoint(
        {
          baseUrl,
          api: apiKind,
          keySource: keySource!,
          token: inlineToken,
          pricingPolicy,
          requiresExplicitModels,
        },
        context.signal,
      );
    },

    saveCustom: async (input, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const preset = input.presetId ? findSavedProviderPreset(input.presetId) : undefined;
      if (input.presetId && !preset) {
        throw new Error(`unknown provider preset "${input.presetId}"`);
      }
      const name = input.name.trim();
      const baseUrl = normalizeBaseUrl(preset?.baseUrl ?? input.baseUrl);
      const api = preset?.api ?? input.api;

      // Discovery failure means we cannot prove the id is safe to use: refuse
      // rather than silently allow a collision that would flood the picker.
      requireCompleteReserved();
      const reserved = discoverReservedProviderIds();

      // Refuse bad ids before touching credentials or the network.
      const manifest = loadManifest(dataDir);
      const currentProviders = providersOf(readModelsJson());
      const id = availableProviderId(
        preset?.idStem ?? name,
        new Set([
          ...reserved.ids,
          ...Object.keys(currentProviders),
          ...Object.keys(manifest.owned),
        ]),
      );
      const reason = validateCustomId(id, {
        reserved: new Set(reserved.ids),
        presentInModelsJson: currentProviders[id] !== undefined,
        ownedIds: new Set(Object.keys(manifest.owned)),
      });
      if (reason) throw new Error(reason);

      const keyRef = buildKeyRef(dataDir, input.keySource);

      const credentials = resolveToken(input.keySource);
      if (!credentials.ok) throw new Error(credentials.error);

      const catalogue = await fetchModelCatalogue({
        baseUrl,
        label: name,
        api,
        token: credentials.token,
        signal: context.signal,
      });

      const def: CustomEndpointDef = {
        id,
        presetId: preset?.id,
        name,
        baseUrl,
        api,
        keySource: input.keySource,
        keyRef,
        freeOnly: input.freeOnly,
        selectionMode: input.selectionMode,
        selectedModelIds: input.selectedModelIds,
        pricingPolicy: preset?.pricing ?? (api === "google-generative-ai" ? "unknown" : "gateway-default"),
        requiresExplicitModels: preset?.requiresExplicitModels ?? api === "google-generative-ai",
        origin: "created",
      };

      if (def.requiresExplicitModels) {
        def.freeOnly = false;
        def.selectionMode = "explicit";
      }

      const { models } = selectModelsForSave(catalogue.entries, policyFor(def, api));

      let written: Record<string, unknown> | undefined;
      const { backupPath } = await writeModelsJson((file) => {
        written = blockForEntry(def, blockOf(file, def.id), models);
        return { next: mergeProviders(file, { [def.id]: written }), changed: true };
      });

      try {
        const next = loadManifest(dataDir);
        next.owned[def.id] = { ...def, fingerprint: fingerprintValue(written), updatedAt: new Date().toISOString() };
        saveManifest(dataDir, next);
      } catch (error) {
        // models.json already carries the new block; say so, because a retry
        // of the same save is what repairs ownership recording.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`saved into models.json but could not update the plugin manifest (${detail}); run the same save again`);
      }

      return {
        modelsJsonPath: modelsJsonPath(),
        backupPath,
        id: def.id,
        modelCount: models.length,
        warning: def.requiresExplicitModels
          ? `${def.name} does not guarantee catalogue pricing; the selected models may incur charges`
          : def.freeOnly
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
      const acceptDrift = new Set(input.acceptDrift ?? []);

      interface Prepared {
        id: string;
        entry: CustomEndpointDef;
        api: ApiKind;
        entries: CatalogueEntry[];
      }
      const prepared: Prepared[] = [];
      const results: Array<{
        id: string;
        ok: boolean;
        modelCount?: number;
        error?: string;
        warning?: string;
        missing?: string[];
        drifted?: boolean;
      }> = [];

      // Phase one: everything that can fail per id without touching the file.
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
        const api = asApiKind(entry.api);
        if (!api) {
          results.push({ id, ok: false, error: UNSUPPORTED_API_ERROR });
          continue;
        }
        try {
          const credentials = resolveEntryToken(entry, blockOf(readModelsJson(), id));
          if (!credentials.ok) throw new Error(credentials.error);
          const catalogue = await fetchModelCatalogue({
            baseUrl: entry.baseUrl,
            label: entry.name,
            api,
            token: credentials.token,
            signal: context.signal,
          });
          prepared.push({ id, entry, api, entries: catalogue.entries });
        } catch (error) {
          results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }

      // Phase two: one critical section for every id that made it this far, so
      // the drift check, the selection and the write all see the same bytes.
      const written = new Map<string, Record<string, unknown>>();
      let backupPath: string | undefined;
      const attempted: typeof results = [];
      if (prepared.length > 0) {
        const result = await writeModelsJson((file) => {
          attempted.length = 0;
          written.clear();
          const blocks: Record<string, Record<string, unknown>> = {};
          for (const item of prepared) {
            const live = blockOf(file, item.id);
            try {
              if (isDrifted(item.entry, live) && !acceptDrift.has(item.id)) {
                attempted.push({ id: item.id, ok: false, drifted: true, error: DRIFT_ERROR_SUFFIX });
                continue;
              }
              const selection = selectModelsForSave(item.entries, policyFor(item.entry, item.api), {
                mode: "refresh",
                liveModels: modelsOf(live),
              });
              const block = blockForEntry(item.entry, live, selection.models);
              blocks[item.id] = block;
              written.set(item.id, block);
              attempted.push({
                id: item.id,
                ok: true,
                modelCount: selection.models.length,
                missing: selection.missing.length > 0 ? selection.missing : undefined,
                warning: selection.missing.length > 0
                  ? `kept ${selection.missing.length} model(s) the catalogue no longer lists: ${selection.missing.slice(0, 5).join(", ")}`
                  : undefined,
                drifted: isDrifted(item.entry, live) || undefined,
              });
            } catch (error) {
              attempted.push({
                id: item.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          return {
            next: mergeProviders(file, blocks),
            changed: Object.keys(blocks).length > 0,
          };
        });
        backupPath = result.backupPath;
      }
      results.push(...attempted);

      rememberFingerprints(dataDir, written);

      return {
        modelsJsonPath: modelsJsonPath(),
        backupPath,
        results: ids
          .map((id) => results.find((result) => result.id === id))
          .filter((result): result is (typeof results)[number] => result !== undefined),
      };
    },

    updateCustom: async (input, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const { entry } = requireManagedEntry(dataDir, input.id);
      const warnings: string[] = [];

      const next: CustomEndpointDef = { ...entry };
      if (input.name !== undefined) next.name = input.name.trim();
      if (input.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(input.baseUrl);
      if (input.freeOnly !== undefined) next.freeOnly = input.freeOnly;
      if (input.selectionMode !== undefined) next.selectionMode = input.selectionMode;
      if (input.selectedModelIds !== undefined) next.selectedModelIds = input.selectedModelIds;
      if (input.linkPresetId !== undefined) {
        if (input.linkPresetId === null) {
          next.presetId = undefined;
        } else {
          const preset = findSavedProviderPreset(input.linkPresetId);
          if (!preset) throw new Error(`unknown provider preset "${input.linkPresetId}"`);
          next.presetId = preset.id;
          next.pricingPolicy = preset.pricing;
          next.requiresExplicitModels = preset.requiresExplicitModels;
        }
      }

      const liveBefore = blockOf(readModelsJson(), input.id);

      if (input.keySource) {
        // Migrating a key reference: the value behind the new source must be
        // the value the provider is using, or the user must say they know.
        const replacement = resolveToken(input.keySource);
        if (!replacement.ok) throw new Error(replacement.error);
        const current = resolveEntryToken(entry, liveBefore);
        if (current.ok && current.token !== replacement.token && !input.confirmMismatch) {
          throw new Error(
            "the new key source resolves to a different token than this provider currently uses — the key may have been rotated; confirm to rewrite the block with the new reference anyway",
          );
        }
        if (current.ok && current.token !== replacement.token) {
          warnings.push("the new key source resolved to a different token than the provider used before");
        }
        next.keySource = input.keySource;
        next.keyRef = buildKeyRef(dataDir, input.keySource);
      }

      const api = asApiKind(next.api);
      let entries: CatalogueEntry[] = [];
      let allowUnverified = input.allowUnverifiedModels === true;

      if (api) {
        const credentials = resolveEntryToken(next, liveBefore);
        if (!credentials.ok) {
          if (!allowUnverified) throw new Error(credentials.error);
          warnings.push(`the credential could not be resolved (${credentials.error}); the model list was kept as given`);
        } else {
          try {
            const catalogue = await fetchModelCatalogue({
              baseUrl: next.baseUrl,
              label: next.name,
              api,
              token: credentials.token,
              signal: context.signal,
            });
            entries = catalogue.entries;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            // A base URL change is only allowed against a catalogue we could
            // actually reach: otherwise "saved" would mean "pointed at nothing".
            if (input.baseUrl !== undefined || !allowUnverified) {
              throw new Error(`could not reach the catalogue at ${next.baseUrl}: ${detail}`);
            }
            warnings.push(`the catalogue could not be read (${detail}); the model list was kept as given`);
          }
        }
      } else {
        // Adopted-limited entry: no protocol we can speak, so the model list is
        // whatever the user says it is.
        if (!allowUnverified && input.selectedModelIds !== undefined) {
          throw new Error(`${UNSUPPORTED_API_ERROR} — pass allowUnverifiedModels to edit its model list by hand`);
        }
        allowUnverified = true;
        next.selectionMode = "explicit";
        if (next.selectedModelIds === undefined) {
          next.selectedModelIds = modelsOf(liveBefore)
            .filter((model): model is { id: string } =>
              Boolean(model) && typeof model === "object" && typeof (model as { id?: unknown }).id === "string")
            .map((model) => model.id);
        }
      }

      let writtenBlock: Record<string, unknown> | undefined;
      let missing: string[] = [];
      let modelCount = 0;
      const { backupPath } = await writeModelsJson((file) => {
        const live = blockOf(file, input.id);
        if (isDrifted(entry, live) && !input.acceptDrift) {
          throw new Error(DRIFT_ERROR_SUFFIX);
        }
        const selection = selectModelsForSave(entries, policyFor(next, api ?? "openai-completions"), {
          mode: "save",
          liveModels: modelsOf(live),
          allowUnverifiedModels: allowUnverified,
        });
        missing = selection.missing;
        modelCount = selection.models.length;
        writtenBlock = blockForEntry(next, live, selection.models);
        return { next: mergeProviders(file, { [input.id]: writtenBlock }), changed: true };
      });

      const manifest = loadManifest(dataDir);
      manifest.owned[input.id] = {
        ...next,
        fingerprint: fingerprintValue(writtenBlock),
        updatedAt: new Date().toISOString(),
      };
      saveManifest(dataDir, manifest);

      if (missing.length > 0) {
        warnings.push(`kept ${missing.length} model(s) the catalogue does not list: ${missing.slice(0, 5).join(", ")}`);
      }
      if (!next.freeOnly && next.selectionMode !== "all-free") {
        warnings.push("paid models may be included — every one of them can spend real money on this endpoint");
      }

      return {
        modelsJsonPath: modelsJsonPath(),
        backupPath,
        id: input.id,
        modelCount,
        warning: warnings.length > 0 ? warnings.join("; ") : undefined,
        missing: missing.length > 0 ? missing : undefined,
      };
    },

    adopt: async (input, context) => {
      const dataDir = context.experimental_paths.dataDir;
      // Adoption must obey the same fail-closed reserved-id rule as saving: a
      // missing denylist is invisible, and pi would merge its whole catalogue.
      requireCompleteReserved();
      const reserved = discoverReservedProviderIds();
      const manifest = loadManifest(dataDir);
      const block = blockOf(readModelsJson(), input.id);
      if (!block) throw new Error(`"${input.id}" is not a provider in ${modelsJsonPath()}`);

      const preset = input.linkPresetId ? findSavedProviderPreset(input.linkPresetId) : undefined;
      if (input.linkPresetId && !preset) {
        throw new Error(`unknown provider preset "${input.linkPresetId}"`);
      }

      const plan = planAdoption({
        dataDir,
        id: input.id,
        block,
        reserved: new Set(reserved.ids),
        ownedIds: new Set(Object.keys(manifest.owned)),
        keyMigration: input.keyMigration,
        confirmMismatch: input.confirmMismatch,
        linkPreset: preset
          ? {
              id: preset.id,
              pricing: preset.pricing,
              requiresExplicitModels: preset.requiresExplicitModels,
              baseUrl: preset.baseUrl,
            }
          : undefined,
      });

      let fingerprintOf: unknown = block;
      let backupPath: string | undefined;
      if (plan.rewriteApiKey !== undefined) {
        // The only writing adoption path: swap the literal for a reference and
        // leave every other field, including headers, exactly as it was.
        let updated: Record<string, unknown> | undefined;
        const result = await writeModelsJson((file) => {
          const live = blockOf(file, input.id);
          if (!live) throw new Error(`"${input.id}" disappeared from models.json before it could be adopted`);
          updated = { ...live, apiKey: plan.rewriteApiKey };
          return { next: mergeProviders(file, { [input.id]: updated }), changed: true };
        });
        backupPath = result.backupPath;
        fingerprintOf = updated;
      }

      const nextManifest = loadManifest(dataDir);
      nextManifest.owned[input.id] = { ...plan.entry, fingerprint: fingerprintValue(fingerprintOf) };
      saveManifest(dataDir, nextManifest);

      return {
        id: input.id,
        ownership: "adopted" as const,
        keyRefKind: plan.keyRefKind,
        inPlaceKey: plan.inPlaceKey,
        modelCount: modelsOf(block).length,
        apiSupported: plan.apiSupported,
        warnings: plan.warnings,
        backupPath,
      };
    },

    disown: async (input, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const manifest = loadManifest(dataDir);
      const entry = manifest.owned[input.id];
      if (!entry) throw new Error(`"${input.id}" is not managed by this plugin`);
      if (!isCustomDef(entry)) throw new Error("built-in gateways cannot be disowned");
      // Manifest only: the block stays in models.json exactly as it is, which
      // is what makes adoption a reversible, zero-risk operation.
      return { id: input.id, forgotten: disownProvider(dataDir, input.id) };
    },

    deleteProvider: async (input, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const manifest = loadManifest(dataDir);
      const entry = manifest.owned[input.id];
      const file = readModelsJson();
      const present = blockOf(file, input.id) !== undefined;
      const reserved = discoverReservedProviderIds();

      if (isBuiltinId(input.id)) {
        throw new Error("built-in gateways are managed by `bb pi-gateways remove`, not deleted here");
      }

      if (isCustomDef(entry)) {
        if (input.disownOnly) {
          disownProvider(dataDir, input.id);
          return { removed: [], backupPath: undefined, disowned: true };
        }
      } else {
        if (reserved.ids.includes(input.id)) {
          throw new Error(
            `"${input.id}" is an id pi ships its own catalogue for; this plugin will not write or delete it`,
          );
        }
        if (!present) throw new Error(`"${input.id}" is neither managed by this plugin nor present in models.json`);
        if (!input.force) {
          throw new Error(
            `"${input.id}" is not managed by this plugin — deleting it may simply be undone by whatever writes it; pass force to delete it anyway`,
          );
        }
      }

      let removed: string[] = [];
      const { backupPath } = await writeModelsJson((current) => {
        const result = dropProviders(current, [input.id]);
        removed = result.removed;
        return { next: result.next, changed: result.removed.length > 0 };
      });

      if (isCustomDef(entry)) {
        const nextManifest = loadManifest(dataDir);
        delete nextManifest.owned[input.id];
        saveManifest(dataDir, nextManifest);
      }

      return { removed, backupPath, disowned: false };
    },

    deleteCustom: async (input, context) => {
      // Kept as a thin alias so a stale app bundle keeps working for one release.
      const dataDir = context.experimental_paths.dataDir;
      const manifest = loadManifest(dataDir);
      const entry = manifest.owned[input.id];
      if (!entry) throw new Error(`"${input.id}" is not a known endpoint`);
      if (!isCustomDef(entry)) {
        throw new Error("built-in gateways are managed by `bb pi-gateways remove`, not deleted here");
      }
      let removed: string[] = [];
      const { backupPath } = await writeModelsJson((file) => {
        const result = dropProviders(file, [input.id]);
        removed = result.removed;
        return { next: result.next, changed: result.removed.length > 0 };
      });
      const nextManifest = loadManifest(dataDir);
      delete nextManifest.owned[input.id];
      saveManifest(dataDir, nextManifest);
      return { removed, backupPath };
    },

    listProviders: async (_input, context) => {
      const { manifest, providers, reserved, reservedDiscovery, ids } = inventory(
        context.experimental_paths.dataDir,
      );
      return {
        modelsJsonPath: modelsJsonPath(),
        reservedComplete: reservedDiscovery.complete,
        providers: [...ids]
          .sort((a, b) => a.localeCompare(b))
          .map((id) =>
            rowFor({
              id,
              entry: manifest.owned[id],
              block: blockOf({ providers } as ModelsJson, id),
              reserved,
            }),
          ),
      };
    },

    providerDetail: async (input, context) => {
      const { manifest, providers, reserved } = inventory(context.experimental_paths.dataDir);
      const block = blockOf({ providers } as ModelsJson, input.id);
      const entry = manifest.owned[input.id];
      if (!block && !entry) throw new Error(`"${input.id}" is neither in models.json nor known to this plugin`);
      const row = rowFor({ id: input.id, entry, block, reserved });
      const custom = isCustomDef(entry) ? entry : undefined;

      const models = block
        ? modelsOf(block)
            .filter((model): model is Record<string, unknown> =>
              Boolean(model) && typeof model === "object" && typeof (model as { id?: unknown }).id === "string")
            .map((model) => ({
              id: model.id as string,
              name: typeof model.name === "string" ? model.name : undefined,
              contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
              maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
            }))
        : (custom?.selectedModelIds ?? []).map((id) => ({ id }));

      return {
        row,
        models,
        manifest: custom
          ? {
              origin: custom.origin,
              keySource: { type: custom.keySource.type },
              adoptedAt: custom.adoptedAt,
              updatedAt: custom.updatedAt,
            }
          : undefined,
        // Names only: header values resolve exactly like api keys, so they are
        // assumed to be secrets and never leave the host.
        headerNames: headerNamesOf(block),
      };
    },

    listCustom: async (_input, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const manifest = loadManifest(dataDir);
      const providers = providersOf(readModelsJson());
      return {
        modelsJsonPath: modelsJsonPath(),
        endpoints: Object.entries(manifest.owned)
          .filter(([, entry]) => isCustomDef(entry))
          .map(([id, entry]) => ({ ...(entry as CustomEndpointDef), id }))
          .map((def) => {
            const block = providers[def.id] as Record<string, unknown> | undefined;
            return {
              id: def.id,
              presetId: def.presetId,
              name: def.name,
              baseUrl: def.baseUrl,
              api: def.api,
              // The redacted rendering, not the reference: an adopted block's
              // apiKey may be the secret itself.
              keyRef: keyRefDisplayFor(def, block).display,
              freeOnly: def.freeOnly,
              selectionMode: def.selectionMode,
              pricingPolicy: effectivePricingPolicy(def),
              requiresExplicitModels: requiresExplicitModelSelection(def),
              inModelsJson: block !== undefined,
              modelCount: Array.isArray(block?.models) ? (block.models as unknown[]).length : 0,
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    },
  },
});
