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
  selectFreeModels,
  type CatalogueEntry,
  type ModelEntry,
} from "./gateways.js";
import type { ApiKind, KeySource } from "./contract.js";
import { writeFileAtomic } from "./fsutil.js";

export interface CustomEndpointDef {
  id: string;
  name: string;
  baseUrl: string;
  api: ApiKind;
  keySource: KeySource;
  /** The exact reference string written into models.json; contains no secret. */
  keyRef: string;
  freeOnly: boolean;
  selectionMode: "all-free" | "explicit";
  selectedModelIds?: string[];
}

type OwnedEntry = { builtin: true } | CustomEndpointDef;

/** The union is shaped so only builtin entries carry the key at all. */
export function isCustomDef(entry: OwnedEntry | undefined): entry is CustomEndpointDef {
  return entry !== undefined && !("builtin" in entry);
}

interface Manifest {
  version: 1;
  /** ids this plugin owns in models.json; builtins recorded so they can never be taken over. */
  owned: Record<string, OwnedEntry>;
}

const MANIFEST_VERSION = 1;
/** Providers pi instantiates without a static catalogue file — still forbidden as ids. */
const DYNAMIC_RESERVED_IDS = ["radius"];
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

// ---------------------------------------------------------------------------
// Manifest

export function manifestPath(dataDir: string): string {
  return join(dataDir, "custom-endpoints.json");
}

function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, owned: {} };
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
  if (manifest?.version !== MANIFEST_VERSION || typeof manifest.owned !== "object" || manifest.owned === null) {
    throw new Error(`${path} has an unsupported format; fix or remove it by hand`);
  }
  ensureBuiltinsOwned(manifest);
  return manifest;
}

export function saveManifest(dataDir: string, manifest: Manifest): void {
  writeFileAtomic(manifestPath(dataDir), `${JSON.stringify(manifest, null, 2)}\n`);
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
export function resolveToken(source: KeySource): { ok: true; token: string } | { ok: false; error: string } {
  try {
    switch (source.type) {
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
        // Same shape as pi's own command resolution: shell out, take stdout,
        // ten-second ceiling. The output never leaves this function.
        const raw = execFileSync("bash", ["-c", source.command], {
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
  if (api === "anthropic-messages") {
    return { "x-api-key": token, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${token}` };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}

interface Pricing {
  prompt?: string | number;
  completion?: string | number;
}

interface CatalogueEntryWithPrice extends CatalogueEntry {
  pricing?: Pricing;
}

/**
 * Free means a listed zero price on both sides. A missing pricing block also
 * counts as free — gateways like OpenCode Zen list only what the credential is
 * entitled to — but such models carry priceKnown=false so the UI can say that
 * no price was actually published.
 */
export function classifyModel(entry: CatalogueEntryWithPrice): { free: boolean; priceKnown: boolean } {
  const pricing = entry.pricing;
  if (!pricing || (pricing.prompt === undefined && pricing.completion === undefined)) {
    return { free: true, priceKnown: false };
  }
  const prompt = Number(pricing.prompt ?? NaN);
  const completion = Number(pricing.completion ?? NaN);
  return { free: prompt === 0 && completion === 0, priceKnown: true };
}

export async function fetchCatalogueEntries(opts: {
  baseUrl: string;
  api: ApiKind;
  token: string;
  signal?: AbortSignal;
}): Promise<{ httpStatus: number; entries: CatalogueEntryWithPrice[] }> {
  const base = normalizeBaseUrl(opts.baseUrl);
  const response = await fetchWithTimeout(
    `${base}/models`,
    { headers: { accept: "application/json", ...authHeaders(opts.api, opts.token) } },
    15_000,
    opts.signal,
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${base}/models${response.status === 401 ? " — the credential was rejected" : ""}`);
  }
  const body = (await response.json()) as { data?: CatalogueEntryWithPrice[] } | CatalogueEntryWithPrice[];
  const items = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(items)) throw new Error("the endpoint returned no model list");
  return { httpStatus: response.status, entries: items };
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
  models: Array<{ id: string; name?: string; contextWindow?: number; free: boolean; priceKnown: boolean }>;
  freeCount: number;
  totalCount: number;
  sampleCall?: { ok: boolean; status?: number; error?: string };
}

export async function probeEndpoint(
  input: { baseUrl: string; api: ApiKind; keySource: KeySource },
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const credentials = resolveToken(input.keySource);
  if (!credentials.ok) return { ok: false, models: [], freeCount: 0, totalCount: 0, error: credentials.error };

  let catalogue: Awaited<ReturnType<typeof fetchCatalogueEntries>>;
  try {
    catalogue = await fetchCatalogueEntries({ baseUrl: input.baseUrl, api: input.api, token: credentials.token, signal });
  } catch (error) {
    return { ok: false, models: [], freeCount: 0, totalCount: 0, error: error instanceof Error ? error.message : String(error) };
  }

  const models = catalogue.entries
    .map((entry) => ({
      id: entry.id ?? "",
      name: entry.name,
      contextWindow: typeof entry.context_length === "number" && entry.context_length > 0 ? entry.context_length : undefined,
      ...classifyModel(entry),
    }))
    .filter((model) => model.id)
    .sort((a, b) => a.id.localeCompare(b.id));

  const chatCapableFree = models.filter((model) => model.free && !NOT_A_CHAT_MODEL.test(model.id));

  let sampleCall: ProbeResult["sampleCall"];
  if (chatCapableFree.length > 0) {
    sampleCall = await sampleChatCall({
      baseUrl: input.baseUrl,
      api: input.api,
      modelId: chatCapableFree[0]!.id,
      token: credentials.token,
      signal,
    });
  }

  return {
    ok: true,
    httpStatus: catalogue.httpStatus,
    models,
    freeCount: chatCapableFree.length,
    totalCount: models.length,
    sampleCall,
  };
}

// ---------------------------------------------------------------------------
// Selection for saving

export function selectModelsForSave(
  entries: readonly CatalogueEntryWithPrice[],
  def: Pick<CustomEndpointDef, "freeOnly" | "selectionMode" | "selectedModelIds">,
): ModelEntry[] {
  let models: ModelEntry[];
  if (def.selectionMode === "explicit") {
    const wanted = new Set(def.selectedModelIds ?? []);
    const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
    const missing = [...wanted].filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new Error(`catalogue no longer lists: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
    }
    if (def.freeOnly) {
      // Never trust the client's claim that these are free: re-check against
      // the fresh catalogue, otherwise a stale UI list could spend money.
      const paid = [...wanted].filter((id) => !classifyModel(byId.get(id)!).free);
      if (paid.length > 0) {
        throw new Error(`refusing to save paid models while free-only is on: ${paid.slice(0, 5).join(", ")}`);
      }
    }
    models = [...wanted].sort().map((id) => {
      const entry = byId.get(id)!;
      const model: ModelEntry = { id };
      if (entry.name) model.name = entry.name;
      if (typeof entry.context_length === "number" && entry.context_length > 0) model.contextWindow = entry.context_length;
      return model;
    });
  } else if (def.freeOnly) {
    models = selectFreeModels(entries);
  } else {
    models = entries
      .filter((entry) => entry.id && !NOT_A_CHAT_MODEL.test(entry.id))
      .map((entry) => {
        const model: ModelEntry = { id: entry.id! };
        if (entry.name) model.name = entry.name;
        if (typeof entry.context_length === "number" && entry.context_length > 0) model.contextWindow = entry.context_length;
        return model;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  if (models.length === 0) {
    throw new Error(
      def.freeOnly
        ? "the catalogue currently lists no zero-priced model — nothing would be saved"
        : "no selectable models found in the catalogue",
    );
  }
  return models;
}
