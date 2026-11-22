/**
 * Shared pure helpers — the single source of truth for provider-key
 * normalization and favorites-store sanitization.
 *
 * Imported by BOTH the client bundle (src/*, app.tsx) and the server entry
 * (server.ts), so this module must stay free of DOM, React, SDK and storage
 * dependencies. Fixes PLUG-362 M11: every read/write path used to normalize
 * provider keys with its own heuristics; now all of them call this file.
 */

export type FavoritesMap = Record<string, string[]>;
export type ModelLabels = Record<string, string>;

/** Versioned server-side snapshot kept under a single KV key. */
export interface FavoritesSnapshot {
  version: number;
  favorites: FavoritesMap;
  modelLabels: ModelLabels;
}

export const PROVIDER_UNKNOWN = "default";

const SHORTCUT_RE = /[⌘⇧⌥⌃]|\b(alt|ctrl|control|shift|cmd|meta)\b/i;

const PROVIDER_ALIASES = new Map([
  ["codex", "codex"], ["openai", "codex"], ["codex (openai)", "codex"],
  ["claude", "provider-claude-code"], ["claude code", "provider-claude-code"],
  ["claude-code", "provider-claude-code"], ["provider-claude-code", "provider-claude-code"],
  ["anthropic", "provider-claude-code"], ["claude code (anthropic)", "provider-claude-code"],
  ["pi", "provider-pi"], ["provider-pi", "provider-pi"], ["inflection", "provider-pi"],
  ["pi (inflection)", "provider-pi"],
  ["agy", "agy"], ["provider-agy", "agy"], ["antigravity", "agy"], ["antigravity (agy)", "agy"],
  ["devin", "acp-devin"], ["opencode", "acp-opencode"], ["cursor", "acp-cursor"],
  ["google antigravity", "acp-antigravity"], ["google-antigravity", "acp-antigravity"],
  ["acp web gemini", "acp-web-gemini"],
]);

export interface ProviderIdentity {
  id: string;
  displayName: string;
}

function providerText(name: string): string {
  return name.toLowerCase().trim();
}

/** Resolve a provider label or legacy key to an SDK ID. */
export function normalizeProviderId(name: string, providers: readonly ProviderIdentity[] = []): string {
  const raw = providerText(name || "");
  if (raw === PROVIDER_UNKNOWN || Object.hasOwn(Object.prototype, raw)) return PROVIDER_UNKNOWN;
  const exact = providers.find(({ id }) => providerText(id) === raw);
  if (exact) return exact.id;
  const byLabel = providers.filter(({ displayName }) => providerText(displayName) === raw);
  if (byLabel.length === 1) return byLabel[0].id;
  if (byLabel.length > 1 || SHORTCUT_RE.test(raw)) return PROVIDER_UNKNOWN;

  const clean = raw.split(/ · |\//, 1)[0].trim();
  if (!clean || Object.hasOwn(Object.prototype, clean)) return PROVIDER_UNKNOWN;
  const known = PROVIDER_ALIASES.get(clean) ?? (clean.startsWith("pi-") ? "provider-pi" : undefined);
  const matches = providers.filter(({ id, displayName }) => {
    const label = providerText(displayName);
    return known
      ? providerText(id) === known || PROVIDER_ALIASES.get(providerText(id)) === known ||
        PROVIDER_ALIASES.get(label) === known
      : label.replace(/\s+/g, "-") === clean;
  });
  if (matches.length === 1) return matches[0].id;
  return known ?? clean.replace(/\s+/g, "-");
}

/** Validate picker labels against the directory or the known label aliases. */
export function resolvePickerProviderId(label: string, providers: readonly ProviderIdentity[]): string {
  const text = providerText(label);
  if (providers.some(({ id, displayName }) => providerText(id) === text || providerText(displayName) === text) ||
      PROVIDER_ALIASES.has(text)) {
    return normalizeProviderId(label, providers);
  }
  return PROVIDER_UNKNOWN;
}

/**
 * Strips keyboard-shortcut residue (e.g. "⇧-⌘-m", "Alt+M", "Ctrl+Shift+P")
 * that leaks into model labels captured from picker DOM.
 */
export function cleanModelText(text: string): string {
  let out = (text || "")
    .replace(/\s*(⇧|⌘|⌥|⌃)([+\s\-]*(⇧|⌘|⌥|⌃|[a-zа-я0-9]))*/gi, "")
    // Word-modifier chords (" Alt+M", "Ctrl+Shift+P") only count at a token
    // boundary — mid-id hyphens like "foo-alt-2" are part of the model name.
    .replace(/(^|\s)(ctrl|control|alt|option|shift|cmd|meta)\b([+\-][a-z0-9]+)+/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Drop trailing dangling separators like "-" or "·"
  out = out.replace(/[\s·\-]+$/g, "").trim();
  return out;
}

export function labelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function isContextSizeTag(text: string): boolean {
  return /^\d+(?:\.\d+)?[KM]$/i.test(text);
}

/** Canonical picker spelling for the context-size tag emitted by older stars. */
export function normalizeModelKey(text: string): string {
  const clean = cleanModelText(text);
  const [model, tag, ...rest] = clean.split(" · ");
  if (!tag || !isContextSizeTag(tag) || model.endsWith(")")) return clean;
  return [`${model} (${tag})`, ...rest].join(" · ");
}

function inferProviderFromModels(models: string[]): string {
  const sample = models.filter((m) => typeof m === "string").join(" ").toLowerCase();
  if (/\b(gpt|o1|o3|o4)\b/.test(sample) || sample.includes("gpt-")) return "codex";
  if (sample.includes("gemini")) return "agy";
  if (sample.includes("claude")) return "provider-claude-code";
  return "provider-claude-code";
}

/**
 * Normalize a raw favorites map: canonical provider keys, cleaned model ids,
 * deduped non-empty lists. When `keyRemap` is given it records originalKey ->
 * finalKey so callers can rekey companion data (model labels) the same way.
 */
export function sanitizeFavoritesMap(
  raw: FavoritesMap | null | undefined,
  keyRemap?: Map<string, string>,
  providers: readonly ProviderIdentity[] = []
): FavoritesMap {
  const result: FavoritesMap = Object.create(null);
  if (!raw || typeof raw !== "object") return result;
  for (const [key, models] of Object.entries(raw)) {
    if (!Array.isArray(models) || models.length === 0) continue;
    let prov = normalizeProviderId(key, providers);
    if (prov === PROVIDER_UNKNOWN && SHORTCUT_RE.test(key)) {
      prov = normalizeProviderId(inferProviderFromModels(models), providers);
    }
    keyRemap?.set(key, prov);

    const existing = result[prov] || [];
    for (const m of models) {
      if (typeof m !== "string") continue;
      const id = normalizeModelKey(m);
      if (id && !existing.includes(id)) existing.push(id);
    }
    if (existing.length > 0) result[prov] = existing;
  }
  return { ...result };
}

/**
 * Sanitize favorites and their display labels together so both move under the
 * same canonical provider keys (stored label keys are "provider:model").
 */
export function sanitizeStore(
  rawFavorites: FavoritesMap | null | undefined,
  rawLabels: ModelLabels | null | undefined,
  providers: readonly ProviderIdentity[] = []
): { favorites: FavoritesMap; modelLabels: ModelLabels } {
  const remap = new Map<string, string>();
  const favorites = sanitizeFavoritesMap(rawFavorites, remap, providers);

  const modelLabels: ModelLabels = {};
  if (rawLabels && typeof rawLabels === "object") {
    for (const [key, label] of Object.entries(rawLabels)) {
      if (typeof label !== "string") continue;
      const idx = key.indexOf(":");
      if (idx < 0) continue;
      const prov = remap.get(key.slice(0, idx)) ?? normalizeProviderId(key.slice(0, idx), providers);
      const model = normalizeModelKey(key.slice(idx + 1));
      const text = cleanModelText(label);
      if (!model || !text) continue;
      modelLabels[`${prov}:${model}`] = text;
    }
  }
  return { favorites, modelLabels };
}

/** The old agy key covered three providers. Move only records with an
 * explicit provider route or prefix because the model name can be shared. */
export function migrateStore(
  rawFavorites: FavoritesMap,
  rawLabels: ModelLabels,
  providers: readonly ProviderIdentity[] = []
): ReturnType<typeof sanitizeStore> {
  const { favorites, modelLabels } = sanitizeStore(rawFavorites, rawLabels, providers);
  const agyModels = favorites.agy ?? [];
  const remaining = agyModels.filter((model) => {
    const oldKey = labelKey("agy", model);
    const label = modelLabels[oldKey];
    const sources = new Set(
      [model, label ?? ""].flatMap((text) => {
        const route = text.split(" · ")[1] ?? "";
        const prefix = text.includes("/") ? text.slice(0, text.indexOf("/")) : "";
        return [route, prefix].map((part) => normalizeProviderId(part, providers));
      }).filter((id) => id === "agy" || id === "acp-antigravity" || id === "acp-web-gemini")
    );
    if (sources.size !== 1 || sources.has("agy")) return true;
    const [provider] = sources;
    const models = favorites[provider] ?? [];
    if (!models.includes(model)) favorites[provider] = [...models, model];
    const newKey = labelKey(provider, model);
    if (label) modelLabels[newKey] ??= label;
    delete modelLabels[oldKey];
    return false;
  });
  if (remaining.length > 0) favorites.agy = remaining;
  else delete favorites.agy;
  return { favorites, modelLabels };
}

/** Strip one model's label, or a whole provider's labels (m3). */
export function dropLabels(modelLabels: ModelLabels, providerId: string, modelId?: string): ModelLabels {
  const prefix = `${providerId}:`;
  const next: ModelLabels = {};
  for (const [key, label] of Object.entries(modelLabels)) {
    if (modelId === undefined ? key.startsWith(prefix) : key === `${prefix}${modelId}`) continue;
    next[key] = label;
  }
  return next;
}

/** Structural validation for user-supplied import payloads (M12). */
export function isValidFavoritesPayload(data: unknown): data is {
  favorites: FavoritesMap;
  modelLabels?: ModelLabels;
} {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const favs = (data as { favorites?: unknown }).favorites;
  if (!favs || typeof favs !== "object" || Array.isArray(favs)) return false;
  for (const value of Object.values(favs)) {
    if (!Array.isArray(value)) return false;
    for (const item of value) {
      if (typeof item !== "string") return false;
    }
  }
  const labels = (data as { modelLabels?: unknown }).modelLabels;
  if (labels !== undefined) {
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) return false;
    for (const value of Object.values(labels)) {
      if (typeof value !== "string") return false;
    }
  }
  return true;
}
