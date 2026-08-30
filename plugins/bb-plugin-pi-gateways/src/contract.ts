/**
 * The single source of truth for every wire schema this plugin speaks: the
 * host contract, its server-side mirror, and the RPC surface the settings UI
 * calls. Defined once so the three entries cannot drift apart — the host and
 * the server must agree byte-for-byte or every call fails validation.
 */
import { z } from "zod";

/** Model kinds a coding agent cannot drive, however free they are. */
export const API_KINDS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

/**
 * Where a credential lives. Deliberately structured rather than a raw string:
 * pi treats any value that is neither `!command` nor `$VAR` as a **literal**,
 * so accepting an arbitrary keyRef string would let a pasted secret be written
 * straight into models.json. The reference string is built on the host from
 * one of these shapes, and literals have no shape here at all.
 */
export const keySourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), path: z.string().min(1) }),
  z.object({ type: z.literal("env"), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
  z.object({ type: z.literal("command"), command: z.string().min(1) }),
]);
export type KeySource = z.infer<typeof keySourceSchema>;

/**
 * What a client may send. Adoption of a foreign block can end up with the key
 * staying where it is — `{type:"inline"}` — but that variant is *produced* by
 * the host and never accepted from a client, so no caller can trick the plugin
 * into treating a pasted secret as "already on disk".
 */
export const editableKeySourceSchema = keySourceSchema;
export type EditableKeySource = z.infer<typeof editableKeySourceSchema>;

export const manifestKeySourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), path: z.string().min(1) }),
  z.object({ type: z.literal("env"), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
  z.object({ type: z.literal("command"), command: z.string().min(1) }),
  z.object({ type: z.literal("inline") }),
]);
export type ManifestKeySource = z.infer<typeof manifestKeySourceSchema>;

export const ownershipSchema = z.enum([
  "builtin",
  "owned",
  "adopted",
  "foreign",
  "orphaned",
  "reserved",
]);
export type Ownership = z.infer<typeof ownershipSchema>;

export const keyRefKindSchema = z.enum(["command", "env", "env-template", "literal", "none"]);

export const apiKindSchema = z.enum(API_KINDS);
export type ApiKind = z.infer<typeof apiKindSchema>;

export const pricingPolicySchema = z.enum(["gateway-default", "catalogue", "unknown"]);
export type PricingPolicy = z.infer<typeof pricingPolicySchema>;

const gatewayReport = z.object({
  id: z.string(),
  label: z.string(),
  credentialFound: z.boolean(),
  inModelsJson: z.boolean(),
  modelCount: z.number(),
  error: z.string().optional(),
});

const probeModel = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  free: z.boolean(),
  /**
   * False when the catalogue carries no pricing block. Existing gateway
   * semantics may still classify those entries as free; Google models never
   * do, and require explicit selection because their prices are unknown.
   */
  priceKnown: z.boolean(),
});

const probeSampleCall = z.object({
  ok: z.boolean(),
  status: z.number().optional(),
  error: z.string().optional(),
});

const customEndpointReport = z.object({
  id: z.string(),
  presetId: z.string().optional(),
  name: z.string(),
  baseUrl: z.string(),
  /** Widened from the API_KINDS enum: an adopted block may speak an unknown protocol. */
  api: z.string(),
  /** Redacted rendering only — never the raw reference of an adopted block. */
  keyRef: z.string(),
  freeOnly: z.boolean(),
  selectionMode: z.enum(["all-free", "explicit"]),
  pricingPolicy: pricingPolicySchema,
  requiresExplicitModels: z.boolean(),
  inModelsJson: z.boolean(),
  modelCount: z.number(),
  error: z.string().optional(),
});

/**
 * One row of the unified provider inventory: everything in models.json plus
 * everything this plugin remembers owning, whether or not the two agree.
 *
 * `keyRefDisplay` is a *redacted* rendering (see src/keyref.ts). No field on
 * this row ever carries a credential value, including `headers`, which is
 * reduced to a boolean.
 */
export const providerRowSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  baseUrl: z.string().optional(),
  /** Raw value from the file: foreign and adopted-limited blocks may sit outside API_KINDS. */
  api: z.string().optional(),
  apiSupported: z.boolean(),
  ownership: ownershipSchema,
  /** The models.json block no longer matches what we last wrote or adopted. */
  drifted: z.boolean(),
  inModelsJson: z.boolean(),
  modelCount: z.number(),
  keyRefKind: keyRefKindSchema,
  keyRefDisplay: z.string(),
  hasHeaders: z.boolean(),
  presetId: z.string().optional(),
  freeOnly: z.boolean().optional(),
  selectionMode: z.enum(["all-free", "explicit"]).optional(),
  pricingPolicy: pricingPolicySchema.optional(),
  requiresExplicitModels: z.boolean().optional(),
  keySourceType: z.enum(["file", "env", "command", "inline"]).optional(),
  origin: z.enum(["created", "adopted"]).optional(),
  warnings: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export type ProviderRow = z.infer<typeof providerRowSchema>;

const providerModel = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
});

export const contractSchemas = {
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

  reservedIds: {
    input: z.object({}),
    output: z.object({
      ids: z.array(z.string()),
      /** False when pi's bundled catalogue could not be located: saving must then be refused. */
      complete: z.boolean(),
      source: z.string(),
    }),
  },
  probe: {
    input: z.object({
      presetId: z.string().optional(),
      baseUrl: z.string().min(1),
      api: apiKindSchema,
      /** Omitted only together with `id`, where the key is read from the live block. */
      keySource: editableKeySourceSchema.optional(),
      /** A managed provider to borrow the credential from, including inline-keyed ones. */
      id: z.string().min(1).optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      httpStatus: z.number().optional(),
      error: z.string().optional(),
      models: z.array(probeModel),
      freeCount: z.number(),
      totalCount: z.number(),
      sampleCall: probeSampleCall.optional(),
    }),
  },
  saveCustom: {
    input: z.object({
      presetId: z.string().optional(),
      name: z.string().min(1),
      baseUrl: z.string().min(1),
      api: apiKindSchema,
      keySource: keySourceSchema,
      freeOnly: z.boolean(),
      selectionMode: z.enum(["all-free", "explicit"]),
      selectedModelIds: z.array(z.string()).optional(),
    }),
    output: z.object({
      modelsJsonPath: z.string(),
      backupPath: z.string().optional(),
      id: z.string(),
      modelCount: z.number(),
      warning: z.string().optional(),
    }),
  },
  refreshCustom: {
    input: z.object({
      ids: z.array(z.string()).optional(),
      /** Ids whose out-of-band changes the caller has agreed to overwrite. */
      acceptDrift: z.array(z.string()).optional(),
    }),
    output: z.object({
      modelsJsonPath: z.string(),
      backupPath: z.string().optional(),
      results: z.array(
        z.object({
          id: z.string(),
          ok: z.boolean(),
          modelCount: z.number().optional(),
          error: z.string().optional(),
          warning: z.string().optional(),
          /** Selected ids the catalogue no longer lists; kept verbatim rather than dropped. */
          missing: z.array(z.string()).optional(),
          drifted: z.boolean().optional(),
        }),
      ),
    }),
  },
  deleteCustom: {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ removed: z.array(z.string()), backupPath: z.string().optional() }),
  },
  listCustom: {
    input: z.object({}),
    output: z.object({
      modelsJsonPath: z.string(),
      endpoints: z.array(customEndpointReport),
    }),
  },

  listProviders: {
    input: z.object({}),
    output: z.object({
      modelsJsonPath: z.string(),
      /** False when pi's bundled catalogue could not be located: adoption and saving are refused. */
      reservedComplete: z.boolean(),
      providers: z.array(providerRowSchema),
    }),
  },
  providerDetail: {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({
      row: providerRowSchema,
      models: z.array(providerModel),
      manifest: z
        .object({
          origin: z.enum(["created", "adopted"]),
          keySource: z.object({ type: z.enum(["file", "env", "command", "inline"]) }),
          adoptedAt: z.string().optional(),
          updatedAt: z.string().optional(),
        })
        .optional(),
      headerNames: z.array(z.string()),
    }),
  },
  adopt: {
    input: z.object({
      id: z.string().min(1),
      /** Supplying a source rewrites the block's apiKey — the one adoption path that writes. */
      keyMigration: editableKeySourceSchema.optional(),
      confirmMismatch: z.boolean().optional(),
      linkPresetId: z.string().optional(),
    }),
    output: z.object({
      id: z.string(),
      ownership: ownershipSchema,
      keyRefKind: keyRefKindSchema,
      /** True when the credential stays only in models.json and is read live. */
      inPlaceKey: z.boolean(),
      modelCount: z.number(),
      apiSupported: z.boolean(),
      warnings: z.array(z.string()),
      backupPath: z.string().optional(),
    }),
  },
  disown: {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ id: z.string(), forgotten: z.boolean() }),
  },
  updateCustom: {
    input: z.object({
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      keySource: editableKeySourceSchema.optional(),
      confirmMismatch: z.boolean().optional(),
      baseUrl: z.string().min(1).optional(),
      freeOnly: z.boolean().optional(),
      selectionMode: z.enum(["all-free", "explicit"]).optional(),
      selectedModelIds: z.array(z.string()).optional(),
      allowUnverifiedModels: z.boolean().optional(),
      linkPresetId: z.string().nullable().optional(),
      acceptDrift: z.boolean().optional(),
    }),
    output: z.object({
      modelsJsonPath: z.string(),
      backupPath: z.string().optional(),
      id: z.string(),
      modelCount: z.number(),
      warning: z.string().optional(),
      missing: z.array(z.string()).optional(),
    }),
  },
  deleteProvider: {
    input: z.object({
      id: z.string().min(1),
      /** Required for blocks this plugin does not own. */
      force: z.boolean().optional(),
      /** Adopted entries only: drop the manifest entry and leave models.json alone. */
      disownOnly: z.boolean().optional(),
    }),
    output: z.object({
      removed: z.array(z.string()),
      backupPath: z.string().optional(),
      disowned: z.boolean(),
    }),
  },
};

/** The RPC surface the frontend sees: host methods wrapped with a host picker. */
export const rpcSchemas = {
  status: {
    input: z.object({ host: z.string().optional() }),
    output: contractSchemas.status.output,
  },
  refresh: {
    input: z.object({ host: z.string().optional(), only: z.array(z.string()).optional() }),
    output: contractSchemas.refresh.output,
  },
  remove: {
    input: z.object({ host: z.string().optional() }),
    output: contractSchemas.remove.output,
  },
  reservedIds: { input: z.object({ host: z.string().optional() }), output: contractSchemas.reservedIds.output },
  probe: {
    input: contractSchemas.probe.input.extend({ host: z.string().optional() }),
    output: contractSchemas.probe.output,
  },
  saveCustom: {
    input: contractSchemas.saveCustom.input.extend({ host: z.string().optional() }),
    output: contractSchemas.saveCustom.output,
  },
  refreshCustom: {
    input: contractSchemas.refreshCustom.input.extend({ host: z.string().optional() }),
    output: contractSchemas.refreshCustom.output,
  },
  deleteCustom: {
    input: contractSchemas.deleteCustom.input.extend({ host: z.string().optional() }),
    output: contractSchemas.deleteCustom.output,
  },
  listCustom: { input: z.object({ host: z.string().optional() }), output: contractSchemas.listCustom.output },
  listProviders: {
    input: z.object({ host: z.string().optional() }),
    output: contractSchemas.listProviders.output,
  },
  providerDetail: {
    input: contractSchemas.providerDetail.input.extend({ host: z.string().optional() }),
    output: contractSchemas.providerDetail.output,
  },
  adopt: {
    input: contractSchemas.adopt.input.extend({ host: z.string().optional() }),
    output: contractSchemas.adopt.output,
  },
  disown: {
    input: contractSchemas.disown.input.extend({ host: z.string().optional() }),
    output: contractSchemas.disown.output,
  },
  updateCustom: {
    input: contractSchemas.updateCustom.input.extend({ host: z.string().optional() }),
    output: contractSchemas.updateCustom.output,
  },
  deleteProvider: {
    input: contractSchemas.deleteProvider.input.extend({ host: z.string().optional() }),
    output: contractSchemas.deleteProvider.output,
  },
  hosts: {
    input: z.null(),
    output: z.object({ hosts: z.array(z.object({ id: z.string(), name: z.string() })) }),
  },
};

/** Inferred shapes for consumers that want types without importing the runtime schemas. */
export type GatewayReport = z.infer<typeof gatewayReport>;
export type ReservedIdsOutput = z.infer<typeof contractSchemas.reservedIds.output>;
export type ProbeInput = z.infer<typeof contractSchemas.probe.input>;
export type ProbeOutput = z.infer<typeof contractSchemas.probe.output>;
export type SaveCustomInput = z.infer<typeof contractSchemas.saveCustom.input>;
export type SaveCustomOutput = z.infer<typeof contractSchemas.saveCustom.output>;
export type RefreshCustomOutput = z.infer<typeof contractSchemas.refreshCustom.output>;
export type DeleteCustomOutput = z.infer<typeof contractSchemas.deleteCustom.output>;
export type ListCustomOutput = z.infer<typeof contractSchemas.listCustom.output>;
export type CustomEndpointEntry = z.infer<typeof customEndpointReport>;
export type ListProvidersOutput = z.infer<typeof contractSchemas.listProviders.output>;
export type ProviderDetailOutput = z.infer<typeof contractSchemas.providerDetail.output>;
export type AdoptInput = z.infer<typeof contractSchemas.adopt.input>;
export type AdoptOutput = z.infer<typeof contractSchemas.adopt.output>;
export type UpdateCustomInput = z.infer<typeof contractSchemas.updateCustom.input>;
export type UpdateCustomOutput = z.infer<typeof contractSchemas.updateCustom.output>;
export type DeleteProviderOutput = z.infer<typeof contractSchemas.deleteProvider.output>;
