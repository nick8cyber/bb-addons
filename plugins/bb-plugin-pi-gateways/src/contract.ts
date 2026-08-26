/**
 * The single source of truth for every wire schema this plugin speaks: the
 * host contract, its server-side mirror, and the RPC surface the settings UI
 * calls. Defined once so the three entries cannot drift apart — the host and
 * the server must agree byte-for-byte or every call fails validation.
 */
import { z } from "zod";

/** Model kinds a coding agent cannot drive, however free they are. */
export const API_KINDS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

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

export const apiKindSchema = z.enum(API_KINDS);
export type ApiKind = z.infer<typeof apiKindSchema>;

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
  free: z.boolean(),
  /**
   * False when the catalogue carries no pricing block. Such models count as
   * free (some gateways list only what the credential may use), but the UI
   * must show that nobody actually promised a zero price.
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
  name: z.string(),
  baseUrl: z.string(),
  api: apiKindSchema,
  keyRef: z.string(),
  freeOnly: z.boolean(),
  selectionMode: z.enum(["all-free", "explicit"]),
  inModelsJson: z.boolean(),
  modelCount: z.number(),
  error: z.string().optional(),
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
      baseUrl: z.string().min(1),
      api: apiKindSchema,
      keySource: keySourceSchema,
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
      id: z.string().min(1),
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
    input: z.object({ ids: z.array(z.string()).optional() }),
    output: z.object({
      modelsJsonPath: z.string(),
      backupPath: z.string().optional(),
      results: z.array(
        z.object({
          id: z.string(),
          ok: z.boolean(),
          modelCount: z.number().optional(),
          error: z.string().optional(),
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
