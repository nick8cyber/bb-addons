/**
 * User-defined OpenAI-compatible endpoints: persistence, validation, probing,
 * and the selection logic that turns a catalogue into a provider block.
 *
 * The invariants that shape this module:
 *
 * - A credential **value** never reaches disk. The manifest stores the
 *   structured source (file path / env name / command); models.json stores the
 *   reference string pi knows how to resolve (`!command`, `$VAR`). A rotated
 *   token therefore needs no config change.
 * - An id that pi already ships must never be used — pi would merge its entire
 *   bundled catalogue the moment it sees a credential. The reserved list is
 *   read from pi's own installation at runtime and discovery failure blocks
 *   saving entirely (fail closed), because a missing denylist is invisible.
 * - Ownership: other writers hold blocks in models.json too (the generator
 *   behind cliproxy/tokenrouter/nvidia and friends). Only ids this plugin has
 *   recorded in its manifest may be overwritten or deleted.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import {
  GATEWAYS,
  NOT_A_CHAT_MODEL,
  classifyCataloguePrice,
  fetchModelCatalogue,
  selectFreeModels,
  type CatalogueEntry,
  type ModelEntry,
} from "./gateways.js";
import { API_KINDS, type ApiKind, type KeySource, type ManifestKeySource, type Ownership, type PricingPolicy } from "./contract.js";
import { fingerprintValue, writeFileAtomic } from "./fsutil.js";
import {
  displayKeyRef,
  keyRefWarnings,
  parseKeyRef,
  resolveKeyRefValue,
  type KeyRefKind,
} from "./keyref.js";

export interface CustomEndpointDef {
  id: string;
  /** Optional shared-catalogue origin; absent on every pre-preset manifest entry. */
  presetId?: string;
  name: string;
  baseUrl: string;
  /**
   * Widened to a plain string: an adopted block may speak a protocol neither
   * pi nor this plugin knows, and such an entry is still worth managing (the
   * user usually adopted it in order to rename or delete it).
   */
  api: string;
  keySource: ManifestKeySource;
  /**
   * The exact reference string written into models.json; contains no secret.
   * Absent for `inline` entries, where the reference is whatever the live
   * block already holds and is carried forward untouched on every write.
   */
  keyRef?: string;
  freeOnly: boolean;
  selectionMode: "all-free" | "explicit";
  selectedModelIds?: string[];
  /** Saved so refresh applies the same price-safety policy as the original save. */
  pricingPolicy?: PricingPolicy;
  requiresExplicitModels?: boolean;
  /** How the entry entered the manifest. v1 entries are all `created`. */
  origin: ManifestOrigin;
  /** sha256 of the canonical block as last written or adopted by us; drift detector. */
  fingerprint?: string;
  adoptedAt?: string;
  updatedAt?: string;
}

export type ManifestOrigin = "created" | "adopted";

export type OwnedEntry = { builtin: true } | CustomEndpointDef;

/** The union is shaped so only builtin entries carry the key at all. */
export function isCustomDef(entry: OwnedEntry | undefined): entry is CustomEndpointDef {
  return entry !== undefined && !("builtin" in entry);
}

export interface Manifest {
  version: 2;
  /** ids this plugin owns in models.json; builtins recorded so they can never be taken over. */
  owned: Record<string, OwnedEntry>;
}

const MANIFEST_VERSION = 2;
const SUPPORTED_MANIFEST_VERSIONS = [1, 2];
/** Providers pi instantiates without a static catalogue file — still forbidden as ids. */
const DYNAMIC_RESERVED_IDS = ["radius"];
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

// ---------------------------------------------------------------------------
// Manifest

export function manifestPath(dataDir: string): string {
  return join(dataDir, "custom-endpoints.json");
}

function emptyManifest(): Manifest {
  // Built-ins are recorded from the very first load, including after a corrupt
  // file is reseeded: their ids must never look adoptable to anyone.
  const manifest: Manifest = { version: MANIFEST_VERSION, owned: {} };
  ensureBuiltinsOwned(manifest);
  return manifest;
}

export function loadManifest(dataDir: string): Manifest {
  const path = manifestPath(dataDir);
  if (!existsSync(path)) return emptyManifest();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A corrupt manifest must not brick the plugin: keep it for inspection and start over.
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {
      /* fall through to reseed even if the rename failed */
    }
    return emptyManifest();
  }
  const manifest = parsed as Manifest;
  if (
    !SUPPORTED_MANIFEST_VERSIONS.includes(manifest?.version as number) ||
    typeof manifest.owned !== "object" ||
    manifest.owned === null
  ) {
    throw new Error(`${path} has an unsupported format; fix or remove it by hand`);
  }
  // v1 → v2 in memory only; the file is rewritten as v2 by the next save. Every
  // v1 entry was written by saveCustom, so `created` is the truthful origin,
  // and no fingerprint means "never verified" rather than "drifted".
  for (const entry of Object.values(manifest.owned)) {
    if (isCustomDef(entry) && !entry.origin) entry.origin = "created";
  }
  manifest.version = MANIFEST_VERSION;
  ensureBuiltinsOwned(manifest);
  return manifest;
}

export function saveManifest(dataDir: string, manifest: Manifest): void {
  writeFileAtomic(
    manifestPath(dataDir),
    `${JSON.stringify({ ...manifest, version: MANIFEST_VERSION }, null, 2)}\n`,
  );
}

/** Remove the manifest entry and nothing else: the exact inverse of adoption. */
export function disownProvider(dataDir: string, id: string): boolean {
  const manifest = loadManifest(dataDir);
  const entry = manifest.owned[id];
  if (!isCustomDef(entry)) return false;
  delete manifest.owned[id];
  saveManifest(dataDir, manifest);
  return true;
}

function ensureBuiltinsOwned(manifest: Manifest): void {
  for (const builtin of BUILTIN_IDS) {
    if (!(builtin in manifest.owned)) manifest.owned[builtin] = { builtin: true };
  }
}



const BUILTIN_IDS = GATEWAYS.map((gateway) => gateway.id);
export function isBuiltinId(id: string): boolean {
  return BUILTIN_IDS.includes(id);
}

// ---------------------------------------------------------------------------
// Reserved ids: everything pi ships catalogues for, discovered at runtime

interface ReservedDiscovery {
  ids: string[];
  source: string;
  complete: boolean;
}

let reservedCache: ReservedDiscovery | undefined;

/**
 * Locate `<pi-ai>/dist/providers/data` without hardcoding any user path.
 * The host bundle runs from ~/.bb/plugin-host-artifacts/... where plain
 * module resolution cannot see bb-app's tree, hence the fallbacks:
 * env override → require.resolve attempt → ancestors of the `bb` binary and
 * of the current directory looking for the installed pi package.
 */
function locatePiProvidersData(): { dir: string | undefined; source: string } {
  // Two layouts to consider per ancestor: the package nested under pi-coding-agent
  // (how bb-app ships it) and hoisted next to it.
  const NESTED = "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data";
  const HOISTED = "@earendil-works/pi-ai/dist/providers/data";
  const candidates: Array<{ root: string; source: string }> = [];

  const override = process.env.PI_GATEWAYS_PI_PROVIDERS_DATA;
  if (override) return { dir: override, source: "PI_GATEWAYS_PI_PROVIDERS_DATA" };

  try {
    const pkg = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json");
    candidates.push({ root: dirname(pkg), source: "module resolution from plugin bundle" });
  } catch {
    /* expected on installed layouts */
  }

  const bbAnchor = whichBbRealpath();
  for (const anchor of [bbAnchor, process.cwd()]) {
    if (!anchor) continue;
    let current = resolve(anchor);
    while (true) {
      candidates.push({ root: current, source: `directory walk up from ${anchor}` });
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  for (const candidate of candidates) {
    // `<root>/node_modules/…` covers prefixes whose packages sit one level down
    // (any npm-style install); bare `<root>/…` covers roots that already end in
    // a node_modules segment picked up by the walk.
    for (const base of ["node_modules", "."]) {
      for (const rel of [NESTED, HOISTED]) {
        const dir = join(candidate.root, base, rel);
        try {
          if (statSync(dir).isDirectory()) return { dir, source: candidate.source };
        } catch {
          /* ENOENT is the expected case everywhere except the right root */
        }
      }
    }
  }
  return {
    dir: undefined,
    // Diagnosable failure: say which anchors were visible so a broken install
    // can be told apart from a sandboxed worker.
    source: `not found (bb on PATH: ${bbAnchor ?? "none"}; ${candidates.length} roots tried)`,
  };
}

let bbRealpathCache: string | undefined;
function whichBbRealpath(): string | undefined {
  if (bbRealpathCache !== undefined) return bbRealpathCache;
  bbRealpathCache = "";
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const entry = join(dir, "bb");
    if (!existsSync(entry)) continue;
    try {
      bbRealpathCache = realpathSync(entry);
    } catch {
      bbRealpathCache = entry;
    }
    break;
  }
  return bbRealpathCache || undefined;
}

export function discoverReservedProviderIds(): ReservedDiscovery {
  if (reservedCache) return reservedCache;
  const { dir, source } = locatePiProvidersData();
  const ids = new Set<string>(DYNAMIC_RESERVED_IDS);
  let complete = false;
  if (dir) {
    try {
      const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
      for (const file of files) ids.add(file.replace(/\.json$/, ""));
      complete = files.length > 0;
    } catch {
      complete = false;
    }
  }
  reservedCache = {
    ids: [...ids].sort(),
    source: complete ? `${source} (${dir})` : `${source} — incomplete`,
    complete,
  };
  return reservedCache;
}

// ---------------------------------------------------------------------------
// Validation

export function validateCustomId(
  id: string,
  ctx: { reserved: ReadonlySet<string>; presentInModelsJson: boolean; ownedIds: ReadonlySet<string> },
): string | undefined {
  if (!ID_PATTERN.test(id)) {
    return "use 2–63 lowercase letters, digits or dashes, starting with a letter or digit";
  }
  if (isBuiltinId(id)) {
    return `this id belongs to the plugin's built-in ${id} gateway; refresh it instead of overriding it`;
  }
  if (ctx.reserved.has(id)) {
    return "pi ships its own catalogue under this id and would merge every paid model in the moment it sees a credential — pick another id";
  }
  if (ctx.presentInModelsJson && !ctx.ownedIds.has(id)) {
    return "a provider with this id already exists in models.json and is owned by another writer; pick another id";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Key sources → reference strings

const FILE_READER_NAME = "read-file.mjs";

const FILE_READER_SOURCE = `// Prints the contents of the file given as argv[2], trimmed. Written by bb-plugin-pi-gateways.
import { readFileSync } from "node:fs";
const path = process.argv[2];
if (!path) process.exit(1);
let value;
try {
  value = readFileSync(path, "utf8").trim();
} catch {
  process.exit(1);
}
if (!value) process.exit(1);
process.stdout.write(value);
`;

/**
 * Build the reference string pi will resolve later. For a file source a tiny
 * reader script is generated rather than emitting `!cat <path>`: paths with
 * spaces or shell metacharacters would break or inject through a shell, while
 * an argv-passed path never touches one.
 */
export function buildKeyRef(dataDir: string, source: KeySource): string {
  switch (source.type) {
    case "env":
      return `$${source.name}`;
    case "command":
      if (/[\r\n]/.test(source.command)) throw new Error("the command must be a single line");
      return `!${source.command}`;
    case "file": {
      const absolute = isAbsolute(source.path) ? source.path : resolve(source.path);
      if (!existsSync(absolute)) throw new Error(`key file does not exist: ${absolute}`);
      const readerDir = join(dataDir, "readers");
      mkdirSync(readerDir, { recursive: true });
      const readerPath = join(readerDir, FILE_READER_NAME);
      writeFileAtomic(readerPath, FILE_READER_SOURCE, 0o700);
      return `!node ${JSON.stringify(readerPath)} ${JSON.stringify(absolute)}`;
    }
  }
}

/** Resolve a source to the token value, in memory only — mirrors how pi resolves references. */
export function resolveToken(
  source: ManifestKeySource,
): { ok: true; token: string } | { ok: false; error: string } {
  try {
    switch (source.type) {
      case "inline":
        // Nothing was copied into the manifest, so there is nothing to resolve
        // from here: the caller must read the live block instead.
        return {
          ok: false,
          error: "this provider keeps its credential in models.json; resolve it from the live block",
        };
      case "env": {
        const token = process.env[source.name];
        if (!token) return { ok: false, error: `environment variable ${source.name} is not set on this host` };
        return { ok: true, token };
      }
      case "file": {
        const absolute = isAbsolute(source.path) ? source.path : resolve(source.path);
        const token = readFileSync(absolute, "utf8").trim();
        if (!token) return { ok: false, error: `key file ${absolute} is empty` };
        return { ok: true, token };
      }
      case "command": {
        // Same shape as pi's own command resolution: `/bin/sh`, stdout only, a
        // ten-second ceiling. The shell matters — pi runs these through sh, so
        // a bash-only command that passed here would fail in a real session.
        const raw = execFileSync("/bin/sh", ["-c", source.command], {
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (!raw) return { ok: false, error: "the key command produced no output" };
        return { ok: true, token: raw };
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not resolve the credential: ${detail.split("\n")[0]}` };
  }
}

// ---------------------------------------------------------------------------
// Talking to an endpoint

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("only http(s) base URLs are supported");
  }
  if (url.username || url.password) throw new Error("credentials in the URL are not allowed — use a key source instead");
  if (url.search || url.hash) throw new Error("base URL must not contain a query or fragment");
  return trimmed;
}

function authHeaders(api: ApiKind, token: string): Record<string, string> {
  if (api === "google-generative-ai") {
    return { "x-goog-api-key": token };
  }
  if (api === "anthropic-messages") {
    return { "x-api-key": token, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${token}` };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}

type CatalogueEntryWithPrice = CatalogueEntry;

/**
 * Free means a listed zero price on both sides. A missing pricing block also
 * counts as free — gateways like OpenCode Zen list only what the credential is
 * entitled to — but such models carry priceKnown=false so the UI can say that
 * no price was actually published.
 */
export function classifyModel(
  entry: CatalogueEntryWithPrice,
  api: ApiKind,
  pricingPolicy: PricingPolicy = api === "google-generative-ai" ? "unknown" : "gateway-default",
): { free: boolean; priceKnown: boolean } {
  return classifyCataloguePrice(entry, api, pricingPolicy);
}

/** One cheap live call, because a catalogue listing proves nothing about inference. */
export async function sampleChatCall(opts: {
  baseUrl: string;
  api: ApiKind;
  modelId: string;
  token: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const base = normalizeBaseUrl(opts.baseUrl);
  const headers = { "content-type": "application/json", ...authHeaders(opts.api, opts.token) };

  const build = (style: "maxTokens" | "maxCompletionTokens" | "responses" | "anthropic"): { url: string; body: string } => {
    switch (opts.api) {
      case "openai-completions":
        return {
          url: `${base}/chat/completions`,
          body: JSON.stringify({
            model: opts.modelId,
            messages: [{ role: "user", content: "ping" }],
            ...(style === "maxCompletionTokens" ? { max_completion_tokens: 1 } : { max_tokens: 1 }),
          }),
        };
      case "openai-responses":
        // The responses API rejects smaller values for max_output_tokens.
        return { url: `${base}/responses`, body: JSON.stringify({ model: opts.modelId, input: "ping", max_output_tokens: 16 }) };
      case "anthropic-messages":
        return {
          url: `${base}/messages`,
          body: JSON.stringify({ model: opts.modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        };
      case "google-generative-ai":
        return {
          url: `${base}/models/${encodeURIComponent(opts.modelId)}:generateContent`,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "ping" }] }],
            generationConfig: { maxOutputTokens: 1 },
          }),
        };
    }
  };

  const attempt = async (style: Parameters<typeof build>[0]): Promise<{ ok: boolean; status?: number; error?: string }> => {
    const { url, body } = build(style);
    try {
      const response = await fetchWithTimeout(url, { method: "POST", headers, body }, 20_000, opts.signal);
      if (response.ok) return { ok: true, status: response.status };
      const text = (await response.text()).slice(0, 300);
      return { ok: false, status: response.status, error: text || `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const first = await attempt(opts.api === "openai-completions" ? "maxTokens" : "responses");
  // Newer OpenAI-only models reject max_tokens outright; retry once with the field they demand.
  if (!first.ok && first.status === 400 && opts.api === "openai-completions" && /max_completion_tokens/i.test(first.error ?? "")) {
    return attempt("maxCompletionTokens");
  }
  return first;
}

export interface ProbeResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
  models: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    free: boolean;
    priceKnown: boolean;
  }>;
  freeCount: number;
  totalCount: number;
  sampleCall?: { ok: boolean; status?: number; error?: string };
}

export async function probeEndpoint(
  input: {
    baseUrl: string;
    api: ApiKind;
    keySource?: ManifestKeySource;
    /**
     * Already-resolved credential, used for inline-keyed providers whose value
     * only exists in models.json. Never logged, never returned.
     */
    token?: string;
    pricingPolicy?: PricingPolicy;
    requiresExplicitModels?: boolean;
  },
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const credentials = input.token
    ? ({ ok: true, token: input.token } as const)
    : input.keySource
      ? resolveToken(input.keySource)
      : ({ ok: false, error: "no credential source was given" } as const);
  if (!credentials.ok) return { ok: false, models: [], freeCount: 0, totalCount: 0, error: credentials.error };

  let catalogue: Awaited<ReturnType<typeof fetchModelCatalogue>>;
  try {
    catalogue = await fetchModelCatalogue({
      baseUrl: normalizeBaseUrl(input.baseUrl),
      api: input.api,
      token: credentials.token,
      signal,
    });
  } catch (error) {
    return { ok: false, models: [], freeCount: 0, totalCount: 0, error: error instanceof Error ? error.message : String(error) };
  }

  const models = catalogue.entries
    .map((entry) => ({
      id: entry.id ?? "",
      name: entry.name,
      contextWindow: typeof entry.context_length === "number" && entry.context_length > 0 ? entry.context_length : undefined,
      maxTokens: typeof entry.max_tokens === "number" && entry.max_tokens > 0 ? entry.max_tokens : undefined,
      ...classifyModel(entry, input.api, input.pricingPolicy),
    }))
    .filter((model) => model.id)
    .sort((a, b) => a.id.localeCompare(b.id));

  const chatCapable = models.filter((model) => !NOT_A_CHAT_MODEL.test(`${model.id} ${model.name ?? ""}`));
  const freeModels = chatCapable.filter((model) => model.free);
  const smokeCandidates = input.requiresExplicitModels || input.api === "google-generative-ai"
    ? chatCapable
    : freeModels;

  let sampleCall: ProbeResult["sampleCall"];
  if (smokeCandidates.length > 0) {
    sampleCall = await sampleChatCall({
      baseUrl: input.baseUrl,
      api: input.api,
      modelId: smokeCandidates[0]!.id,
      token: credentials.token,
      signal,
    });
  }

  return {
    ok: true,
    httpStatus: catalogue.httpStatus,
    models,
    freeCount: freeModels.length,
    totalCount: models.length,
    sampleCall,
  };
}

// ---------------------------------------------------------------------------
// Selection for saving

export interface SelectionPolicy {
  api: ApiKind;
  freeOnly: boolean;
  selectionMode: "all-free" | "explicit";
  selectedModelIds?: string[];
  pricingPolicy?: PricingPolicy;
  requiresExplicitModels?: boolean;
}

export interface SelectionOptions {
  /**
   * `save` refuses to write a selection the catalogue no longer backs; `refresh`
   * keeps such ids verbatim and reports them. A single delisted model used to
   * brick the refresh of an entire provider, which is the opposite of safe.
   */
  mode?: "save" | "refresh";
  /** The live block's model entries, so kept ids retain their existing metadata. */
  liveModels?: readonly unknown[];
  /** Allow pinning ids the catalogue does not list (unreachable catalogue, limited entry). */
  allowUnverifiedModels?: boolean;
}

export interface SelectionResult {
  models: ModelEntry[];
  /** Selected ids the catalogue no longer lists but which were kept anyway. */
  missing: string[];
}

function liveModelById(liveModels: readonly unknown[] | undefined, id: string): ModelEntry {
  for (const entry of liveModels ?? []) {
    if (entry && typeof entry === "object" && (entry as { id?: unknown }).id === id) {
      const source = entry as Record<string, unknown>;
      const model: ModelEntry = { id };
      if (typeof source.name === "string") model.name = source.name;
      if (typeof source.contextWindow === "number") model.contextWindow = source.contextWindow;
      if (typeof source.maxTokens === "number") model.maxTokens = source.maxTokens;
      return model;
    }
  }
  return { id };
}

export function selectModelsForSave(
  entries: readonly CatalogueEntryWithPrice[],
  def: SelectionPolicy,
  opts: SelectionOptions = {},
): SelectionResult {
  const mode = opts.mode ?? "save";
  const pricingPolicy = effectivePricingPolicy(def);
  if (
    requiresExplicitModelSelection(def) &&
    (def.selectionMode !== "explicit" || !def.selectedModelIds?.length)
  ) {
    throw new Error(
      "catalogue pricing is not guaranteed; explicitly select at least one model before saving",
    );
  }
  let models: ModelEntry[];
  const missing: string[] = [];
  if (def.selectionMode === "explicit") {
    const wanted = new Set(def.selectedModelIds ?? []);
    const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
    const absent = [...wanted].filter((id) => !byId.has(id));
    if (absent.length > 0) {
      const tolerated = mode === "refresh" || opts.allowUnverifiedModels === true;
      if (!tolerated) {
        throw new Error(`catalogue no longer lists: ${absent.slice(0, 5).join(", ")}${absent.length > 5 ? "…" : ""}`);
      }
      missing.push(...absent);
    }
    if (def.freeOnly) {
      // Never trust the client's claim that these are free: re-check against
      // the fresh catalogue, otherwise a stale UI list could spend money.
      const paid = [...wanted].filter(
        (id) => byId.has(id) && !classifyModel(byId.get(id)!, def.api, pricingPolicy).free,
      );
      if (paid.length > 0) {
        throw new Error(`refusing to save paid models while free-only is on: ${paid.slice(0, 5).join(", ")}`);
      }
    }
    models = [...wanted].sort().map((id) => {
      const entry = byId.get(id);
      // Kept-but-delisted ids are copied out of the live block rather than
      // rebuilt, so nothing the user or another writer set on them is lost.
      if (!entry) return liveModelById(opts.liveModels, id);
      const model: ModelEntry = { id };
      if (entry.name) model.name = entry.name;
      if (typeof entry.context_length === "number" && entry.context_length > 0) model.contextWindow = entry.context_length;
      if (typeof entry.max_tokens === "number" && entry.max_tokens > 0) model.maxTokens = entry.max_tokens;
      return model;
    });
  } else if (def.freeOnly) {
    models = selectFreeModels(entries, def.api, pricingPolicy);
  } else {
    models = entries
      .filter((entry) => entry.id && !NOT_A_CHAT_MODEL.test(entry.id))
      .map((entry) => {
        const model: ModelEntry = { id: entry.id! };
        if (entry.name) model.name = entry.name;
        if (typeof entry.context_length === "number" && entry.context_length > 0) model.contextWindow = entry.context_length;
        if (typeof entry.max_tokens === "number" && entry.max_tokens > 0) model.maxTokens = entry.max_tokens;
        return model;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  if (models.length === 0) {
    throw new Error(
      requiresExplicitModelSelection(def)
        ? "explicitly select at least one model — catalogue pricing is not guaranteed"
        : def.freeOnly
        ? "the catalogue currently lists no zero-priced model — nothing would be saved"
        : "no selectable models found in the catalogue",
    );
  }
  return { models, missing };
}

export function effectivePricingPolicy(
  def: { api: string; pricingPolicy?: PricingPolicy },
): PricingPolicy {
  return def.pricingPolicy ?? (def.api === "google-generative-ai" ? "unknown" : "gateway-default");
}

export function requiresExplicitModelSelection(
  def: { api: string; requiresExplicitModels?: boolean },
): boolean {
  return def.requiresExplicitModels ?? def.api === "google-generative-ai";
}


// ---------------------------------------------------------------------------
// Managed entries: credentials, protocol support, ownership

/**
 * Resolve the credential for a managed entry.
 *
 * For `inline` entries the value only ever exists in models.json, so it is
 * read from the block passed in — which callers must have read *fresh*, inside
 * the same critical section as the write that follows. A token cached from an
 * earlier read could be a key the user has since rotated by hand.
 */
export function resolveEntryToken(
  entry: CustomEndpointDef,
  liveBlock: Record<string, unknown> | undefined,
): { ok: true; token: string } | { ok: false; error: string } {
  if (entry.keySource.type !== "inline") return resolveToken(entry.keySource);
  const raw = liveBlock?.apiKey;
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: `${entry.id} has no apiKey in models.json to resolve` };
  }
  return resolveKeyRefValue(raw);
}

export function asApiKind(api: string | undefined): ApiKind | undefined {
  return API_KINDS.includes(api as ApiKind) ? (api as ApiKind) : undefined;
}

export const UNSUPPORTED_API_ERROR = "unsupported wire protocol — this provider can be renamed or deleted, but not probed or refreshed";

/**
 * Derive the ownership state. Never stored: models.json and the manifest are
 * written by different actors at different times, and a cached enum would
 * quietly describe a world that no longer exists.
 */
export function deriveOwnership(args: {
  id: string;
  entry: OwnedEntry | undefined;
  inModelsJson: boolean;
  reserved: ReadonlySet<string>;
}): Ownership {
  if (isBuiltinId(args.id)) return "builtin";
  if (isCustomDef(args.entry)) {
    if (!args.inModelsJson) return "orphaned";
    return args.entry.origin === "adopted" ? "adopted" : "owned";
  }
  if (args.reserved.has(args.id)) return "reserved";
  return "foreign";
}

/** True when the live block differs from what we last wrote or adopted. */
export function isDrifted(entry: CustomEndpointDef, liveBlock: unknown): boolean {
  if (!entry.fingerprint || liveBlock === undefined) return false;
  return fingerprintValue(liveBlock) !== entry.fingerprint;
}

export const DRIFT_ERROR_SUFFIX =
  "this provider changed in models.json since the plugin last wrote it; refreshing would overwrite those changes — retry with drift accepted";

// ---------------------------------------------------------------------------
// Adoption

export interface AdoptionPlan {
  entry: CustomEndpointDef;
  warnings: string[];
  keyRefKind: KeyRefKind;
  /** True when the credential stays in models.json and is read live on demand. */
  inPlaceKey: boolean;
  /** Set only for migrate-on-adopt: the new reference string to write. */
  rewriteApiKey?: string;
  apiSupported: boolean;
}

export interface AdoptionOptions {
  dataDir: string;
  id: string;
  block: Record<string, unknown>;
  reserved: ReadonlySet<string>;
  ownedIds: ReadonlySet<string>;
  /** Migrate the key to a real reference as part of adoption (the only writing variant). */
  keyMigration?: KeySource;
  confirmMismatch?: boolean;
  linkPreset?: { id: string; pricing: PricingPolicy; requiresExplicitModels: boolean; baseUrl: string };
}

/**
 * Decide what adopting a foreign block records, and whether that requires
 * touching models.json at all (it does not, except for a key migration).
 *
 * Adoption is deliberately lossy in one direction only: it never invents
 * permission. A block whose pricing semantics we cannot know is adopted with
 * its current model list pinned explicitly, never with auto-free selection.
 */
export function planAdoption(opts: AdoptionOptions): AdoptionPlan {
  const { id, block } = opts;
  if (isBuiltinId(id)) {
    throw new Error(`"${id}" is one of the plugin's built-in gateways, not an adoptable block`);
  }
  if (opts.ownedIds.has(id)) throw new Error(`"${id}" is already managed by this plugin`);
  if (opts.reserved.has(id)) {
    throw new Error(
      "pi ships its own catalogue under this id and would merge every paid model in the moment it sees a credential — this block cannot be adopted",
    );
  }

  const warnings: string[] = [];
  const rawKey = typeof block.apiKey === "string" ? block.apiKey : undefined;
  const info = parseKeyRef(rawKey);
  warnings.push(...keyRefWarnings(rawKey));

  const api = typeof block.api === "string" ? block.api : "openai-completions";
  const apiSupported = asApiKind(api) !== undefined;
  if (!apiSupported) {
    warnings.push(`this block declares api "${api}", which this plugin cannot probe or refresh — it can still be renamed or deleted`);
  }

  const baseUrl = typeof block.baseUrl === "string" ? block.baseUrl : "";
  const name = typeof block.name === "string" && block.name.trim() ? block.name.trim() : id;

  const liveModels = Array.isArray(block.models) ? block.models : [];
  const selectedModelIds = liveModels
    .filter((entry): entry is { id: string } =>
      Boolean(entry) && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string")
    .map((entry) => entry.id);

  let keySource: ManifestKeySource;
  let rewriteApiKey: string | undefined;

  if (opts.keyMigration) {
    // The one adoption path that writes: replace the literal with a reference.
    const replacement = resolveToken(opts.keyMigration);
    if (!replacement.ok) throw new Error(replacement.error);
    const current = rawKey ? resolveKeyRefValue(rawKey) : undefined;
    if (current?.ok && current.token !== replacement.token && !opts.confirmMismatch) {
      throw new Error(
        "the new key source resolves to a different token than the block currently uses — the key may have been rotated; confirm to rewrite the block with the new reference anyway",
      );
    }
    if (current?.ok && current.token !== replacement.token) {
      warnings.push("the new key source resolved to a different token than the block used before");
    }
    keySource = opts.keyMigration;
    rewriteApiKey = buildKeyRef(opts.dataDir, opts.keyMigration);
  } else {
    switch (info.kind) {
      case "command":
        // Already a command in the config file: copying the string into the
        // manifest exposes nothing that was not exposed a moment ago.
        if (/[\r\n]/.test(info.command)) {
          throw new Error("this block's key command spans several lines; adopt it after simplifying the command");
        }
        keySource = { type: "command", command: info.command };
        break;
      case "env":
        keySource = { type: "env", name: info.name };
        break;
      case "env-template":
        keySource = { type: "inline" };
        warnings.push(
          `the key is a template over ${info.names.join(", ")}; it stays in models.json untouched because this plugin can only record a single reference`,
        );
        break;
      case "literal":
        keySource = { type: "inline" };
        warnings.push(
          "the credential is written literally in models.json; it stays there untouched — migrate it to an environment variable or key file to get it out of the file",
        );
        break;
      case "none":
        keySource = { type: "inline" };
        warnings.push("this block carries no credential; probes and refreshes will send no authorization header");
        break;
    }
  }

  const preset = opts.linkPreset && opts.linkPreset.baseUrl === baseUrl ? opts.linkPreset : undefined;
  if (opts.linkPreset && !preset) {
    warnings.push(`the block's base URL does not match preset "${opts.linkPreset.id}"; the preset was not linked`);
  }

  const now = new Date().toISOString();
  const entry: CustomEndpointDef = {
    id,
    presetId: preset?.id,
    name,
    baseUrl,
    api,
    keySource,
    keyRef: rewriteApiKey ?? (keySource.type === "inline" ? undefined : rawKey),
    // Adoption never grants auto-free-selection: the gateway's pricing
    // semantics are unknown, so what is offered stays exactly what is offered.
    freeOnly: false,
    selectionMode: "explicit",
    selectedModelIds,
    pricingPolicy: preset?.pricing ?? "unknown",
    requiresExplicitModels: preset?.requiresExplicitModels ?? true,
    origin: "adopted",
    adoptedAt: now,
  };

  return {
    entry,
    warnings,
    keyRefKind: info.kind,
    inPlaceKey: keySource.type === "inline",
    rewriteApiKey,
    apiSupported,
  };
}

/** The redacted key rendering for a provider row, whatever its ownership. */
export function keyRefDisplayFor(entry: CustomEndpointDef | undefined, liveBlock: Record<string, unknown> | undefined): {
  kind: KeyRefKind;
  display: string;
} {
  const raw = typeof liveBlock?.apiKey === "string"
    ? (liveBlock.apiKey as string)
    : entry?.keyRef;
  return { kind: parseKeyRef(raw).kind, display: displayKeyRef(raw) };
}
