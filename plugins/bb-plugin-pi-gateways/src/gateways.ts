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
import type { ApiKind } from "./contract.js";

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

export const MODELS_JSON = join(homedir(), ".pi", "agent", "models.json");

/** Model kinds a coding agent cannot drive, however free they are. */
export const NOT_A_CHAT_MODEL = /lyria|veo-|-tts|whisper|embed|rerank|moderation|image-\d/i;

export interface CatalogueEntry {
  readonly id?: string;
  readonly name?: string;
  readonly context_length?: number;
  readonly pricing?: { prompt?: string | number; completion?: string | number };
}

export interface ModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
}

function isFree(entry: CatalogueEntry): boolean {
  const pricing = entry.pricing;
  // No pricing block means the endpoint only lists what this credential is
  // entitled to (OpenCode Zen behaves this way), so treat it as free.
  if (!pricing) return true;
  const prompt = Number(pricing.prompt ?? NaN);
  const completion = Number(pricing.completion ?? NaN);
  return prompt === 0 && completion === 0;
}

/**
 * Pick the models worth offering. Selection is by **price**, never by the word
 * "free" in the id: `stealth/ox-alpha` costs nothing and carries no `:free`
 * suffix, and filtering by name silently drops it.
 */
export function selectFreeModels(items: readonly CatalogueEntry[]): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const item of items) {
    const id = item.id;
    if (!id || NOT_A_CHAT_MODEL.test(id) || !isFree(item)) continue;
    const entry: ModelEntry = { id };
    if (item.name) entry.name = item.name;
    if (typeof item.context_length === "number" && item.context_length > 0) {
      entry.contextWindow = item.context_length;
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
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  token: string;
  signal?: AbortSignal;
}): Promise<{ httpStatus: number; entries: CatalogueEntry[] }> {
  const base = opts.baseUrl.replace(/\/+$/, "");
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
  /** Custom endpoints may pick another wire format; built-ins stay completions-based. */
  api: ApiKind;
  apiKey: string;
  models: ModelEntry[];
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

interface ModelsJson {
  providers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Write our provider blocks into models.json without disturbing anything else
 * in it. Only the ids we own are replaced; hand-added providers survive.
 */
export function mergeProviders(
  existing: ModelsJson | null,
  blocks: Record<string, ProviderBlock>,
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
