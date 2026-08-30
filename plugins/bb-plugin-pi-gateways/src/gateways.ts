/**
 * The two gateways this plugin knows about, and the pure logic around them:
 * catalogue fetching, free-model selection, and a non-destructive merge into
 * pi's models.json.
 *
 * No credential is ever written into a config file here. Each provider entry
 * carries `"apiKey": "!<reader command>"`, and pi runs that command when a
 * session starts — so a rotated token is picked up without touching config,
 * and models.json stays safe to commit.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiKind, PricingPolicy } from "./contract.js";
import type { ModelsJsonFile } from "./fsutil.js";

export type { ApiKind };

export interface Gateway {
  /** Provider id written into models.json. */
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  /** Reader script filename, resolved inside the plugin's host data dir. */
  readonly reader: string;
  /** Where the credential actually lives, for the status report. */
  readonly credentialPath: string;
}

export const GATEWAYS: readonly Gateway[] = [
  {
    // Deliberately not "opencode" or "opencode-go": pi ships its own catalogue
    // under those ids and would merge every paid model in as soon as it sees a
    // credential. A distinct id keeps the picker to the free tier.
    id: "opencode-zen",
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    reader: "read-zen.mjs",
    credentialPath: join(homedir(), ".local/share/opencode/auth.json"),
  },
  {
    id: "kilo",
    label: "Kilo Code",
    baseUrl: "https://api.kilo.ai/api/gateway",
    reader: "read-kilo.mjs",
    credentialPath: join(homedir(), ".local/share/kilo/kilo.db"),
  },
];

/**
 * Where pi keeps its provider catalogue. Resolved per call rather than frozen
 * in a const so `PI_GATEWAYS_MODELS_JSON` can point the whole plugin at a
 * temporary file — the tests must never touch the real one, and a const would
 * capture the value before a test could set it.
 */
export function modelsJsonPath(): string {
  return process.env.PI_GATEWAYS_MODELS_JSON || join(homedir(), ".pi", "agent", "models.json");
}

/** Model kinds a coding agent cannot drive, however free they are. */
export const NOT_A_CHAT_MODEL = /lyria|veo-|-tts|whisper|embed|rerank|moderation|image-\d/i;
const GOOGLE_NON_TEXT_MODEL =
  /(?:^|[-/])(?:image|imagen)(?:$|[-/])|embedding|lyria|veo|tts|speech|audio/i;

export interface CatalogueEntry {
  readonly id?: string;
  readonly name?: string;
  readonly context_length?: number;
  readonly max_tokens?: number;
  readonly pricing?: { prompt?: string | number; completion?: string | number };
}

export interface ModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export function classifyCataloguePrice(
  entry: CatalogueEntry,
  api: ApiKind,
  pricingPolicy: PricingPolicy = api === "google-generative-ai" ? "unknown" : "gateway-default",
): { free: boolean; priceKnown: boolean } {
  // Google AI Studio does not publish price metadata in its model catalogue.
  // Unknown must not collapse into free for this protocol.
  if (api === "google-generative-ai") {
    return { free: false, priceKnown: false };
  }
  const pricing = entry.pricing;
  // No pricing block means the endpoint only lists what this credential is
  // entitled to (OpenCode Zen behaves this way), so treat it as free.
  if (!pricing || (pricing.prompt === undefined && pricing.completion === undefined)) {
    return { free: pricingPolicy === "gateway-default", priceKnown: false };
  }
  const prompt = Number(pricing.prompt ?? NaN);
  const completion = Number(pricing.completion ?? NaN);
  return { free: prompt === 0 && completion === 0, priceKnown: true };
}

/**
 * Pick the models worth offering. Selection is by **price**, never by the word
 * "free" in the id: `stealth/ox-alpha` costs nothing and carries no `:free`
 * suffix, and filtering by name silently drops it.
 */
export function selectFreeModels(
  items: readonly CatalogueEntry[],
  api: ApiKind = "openai-completions",
  pricingPolicy: PricingPolicy = api === "google-generative-ai" ? "unknown" : "gateway-default",
): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const item of items) {
    const id = item.id;
    if (
      !id ||
      NOT_A_CHAT_MODEL.test(id) ||
      !classifyCataloguePrice(item, api, pricingPolicy).free
    ) continue;
    const entry: ModelEntry = { id };
    if (item.name) entry.name = item.name;
    if (typeof item.context_length === "number" && item.context_length > 0) {
      entry.contextWindow = item.context_length;
    }
    if (typeof item.max_tokens === "number" && item.max_tokens > 0) {
      entry.maxTokens = item.max_tokens;
    }
    out.push(entry);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export async function fetchCatalogue(
  gateway: Gateway,
  token: string,
  signal?: AbortSignal,
): Promise<CatalogueEntry[]> {
  const { entries } = await fetchModelCatalogue({
    baseUrl: gateway.baseUrl,
    label: gateway.label,
    token,
    signal,
  });
  return entries;
}

/**
 * Catalogue fetch shared by the built-in gateways and user-defined endpoints.
 * The request shape depends on the API kind: Anthropic-style endpoints
 * authenticate with x-api-key instead of a bearer token.
 */
export async function fetchModelCatalogue(opts: {
  baseUrl: string;
  label?: string;
  api?: ApiKind;
  token: string;
  signal?: AbortSignal;
}): Promise<{ httpStatus: number; entries: CatalogueEntry[] }> {
  const base = opts.baseUrl.replace(/\/+$/, "");

  if (opts.api === "google-generative-ai") {
    const entries: CatalogueEntry[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    let httpStatus = 200;

    for (let page = 0; page < 100; page += 1) {
      const url = pageToken
        ? `${base}/models?pageToken=${encodeURIComponent(pageToken)}`
        : `${base}/models`;
      const response = await fetch(url, {
        // The key deliberately stays in a header. It must never enter URLs,
        // access logs, browser history, or error strings as a query value.
        headers: { accept: "application/json", "x-goog-api-key": opts.token },
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });
      httpStatus = response.status;
      if (!response.ok) {
        throw new Error(`${opts.label ?? base} answered HTTP ${response.status} for /models`);
      }
      const body = (await response.json()) as {
        models?: Array<{
          name?: string;
          displayName?: string;
          inputTokenLimit?: number;
          outputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }>;
        nextPageToken?: string;
      };
      if (!Array.isArray(body.models)) {
        throw new Error(`${opts.label ?? base} returned no model list`);
      }

      for (const model of body.models) {
        const id = model.name?.replace(/^models\//, "");
        if (
          !id ||
          !model.supportedGenerationMethods?.includes("generateContent") ||
          NOT_A_CHAT_MODEL.test(`${id} ${model.displayName ?? ""}`) ||
          GOOGLE_NON_TEXT_MODEL.test(id)
        ) {
          continue;
        }
        entries.push({
          id,
          name: model.displayName,
          context_length: model.inputTokenLimit,
          max_tokens: model.outputTokenLimit,
        });
      }

      const next = body.nextPageToken?.trim();
      if (!next) return { httpStatus, entries };
      if (seenTokens.has(next)) {
        throw new Error(`${opts.label ?? base} repeated a Google catalogue page token`);
      }
      seenTokens.add(next);
      pageToken = next;
    }
    throw new Error(`${opts.label ?? base} returned more than 100 catalogue pages`);
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.api === "anthropic-messages") {
    headers["x-api-key"] = opts.token;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${opts.token}`;
  }
  const response = await fetch(`${base}/models`, {
    headers,
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${opts.label ?? base} answered HTTP ${response.status} for /models`);
  }
  const body = (await response.json()) as { data?: CatalogueEntry[] } | CatalogueEntry[];
  const items = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(items)) throw new Error(`${opts.label ?? base} returned no model list`);
  return { httpStatus: response.status, entries: items };
}

export interface ProviderBlock {
  name: string;
  baseUrl: string;
  /**
   * Custom endpoints may pick another wire format; built-ins stay
   * completions-based. Typed as a plain string because adopted foreign blocks
   * can carry a protocol pi (or this plugin) does not know, and refusing to
   * represent it would mean refusing to let the user delete it.
   */
  api: string;
  /** Absent on blocks that need no credential at all. */
  apiKey?: string;
  models: ModelEntry[];
  /** Adopted blocks may carry header secrets and future pi fields. */
  [key: string]: unknown;
}

export function buildProviderBlock(
  gateway: Gateway,
  readerPath: string,
  models: ModelEntry[],
): ProviderBlock {
  return {
    name: gateway.label,
    baseUrl: gateway.baseUrl,
    api: "openai-completions",
    apiKey: `!node ${JSON.stringify(readerPath)}`,
    models,
  };
}

export type ModelsJson = ModelsJsonFile;

/**
 * Merge our fields onto a block somebody else may have written.
 *
 * Adopted blocks routinely carry things this plugin does not model: `headers`
 * (whose values are credentials), pi fields added after this release, extra
 * keys from the generator that produced them. Constructing a fresh block would
 * silently delete all of it, so every write to an id we did not create is a
 * merge onto the live block, and the credential-bearing fields are carried
 * forward verbatim unless the caller explicitly replaces them.
 */
export function mergeProviderBlock(
  live: unknown,
  ours: Record<string, unknown>,
  models: ModelEntry[],
): Record<string, unknown> {
  const base = live && typeof live === "object" && !Array.isArray(live)
    ? { ...(live as Record<string, unknown>) }
    : {};
  const liveModels = Array.isArray((base as { models?: unknown }).models)
    ? ((base as { models?: unknown }).models as unknown[])
    : [];
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(ours)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  merged.models = mergeModelEntries(liveModels, models);
  return merged;
}

/**
 * Keep unknown per-model fields (custom cost tables, reasoning flags, …) for
 * ids that survive the rewrite; new ids are written exactly as selected.
 */
export function mergeModelEntries(live: readonly unknown[], next: readonly ModelEntry[]): unknown[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of live) {
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      byId.set((entry as { id: string }).id, entry as Record<string, unknown>);
    }
  }
  return next.map((model) => {
    const previous = byId.get(model.id);
    if (!previous) return model;
    const merged: Record<string, unknown> = { ...previous };
    for (const [key, value] of Object.entries(model)) {
      if (value === undefined) continue;
      merged[key] = value;
    }
    return merged;
  });
}

/**
 * Write our provider blocks into models.json without disturbing anything else
 * in it. Only the ids we own are replaced; hand-added providers survive.
 */
export function mergeProviders(
  existing: ModelsJson | null,
  blocks: Record<string, ProviderBlock | Record<string, unknown>>,
): ModelsJson {
  const next: ModelsJson = existing ? { ...existing } : {};
  const providers = { ...((next.providers as Record<string, unknown>) ?? {}) };
  for (const [id, block] of Object.entries(blocks)) providers[id] = block;
  next.providers = providers;
  return next;
}

/** Drop only the ids this plugin owns, leaving the rest of the file intact. */
export function dropProviders(existing: ModelsJson | null, ids: readonly string[]): {
  next: ModelsJson;
  removed: string[];
} {
  const next: ModelsJson = existing ? { ...existing } : {};
  const providers = { ...((next.providers as Record<string, unknown>) ?? {}) };
  const removed: string[] = [];
  for (const id of ids) {
    if (id in providers) {
      delete providers[id];
      removed.push(id);
    }
  }
  next.providers = providers;
  return { next, removed };
}
