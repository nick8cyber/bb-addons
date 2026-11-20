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

/**
 * Canonical provider key for a raw name coming from DOM tab titles, SDK
 * provider ids, manual input or stored data.
 *
 * "default" means "could not name a provider" (shortcut residue, empty) —
 * callers must never store favorites under it.
 */
export function normalizeProviderId(name: string): string {
  let clean = (name || "").toLowerCase().trim();
  if (!clean) return PROVIDER_UNKNOWN;
  // Keyboard-shortcut residue that leaked into captured text ("⇧-⌘-m",
  // "Alt+M") is not a provider name.
  if (SHORTCUT_RE.test(clean)) return PROVIDER_UNKNOWN;
  // Drop model qualifiers: "Provider / Model" and "Model · route" both reduce
  // to the provider part, keeping keys consistent across contexts.
  if (clean.includes(" · ")) clean = clean.split(" · ")[0].trim();
  if (clean.includes("/")) clean = clean.split("/")[0].trim();
  if (!clean) return PROVIDER_UNKNOWN;

  // acp-* ids are distinct providers: only the literal Cursor spellings
  // collapse onto "acp-cursor"; everything else keeps its own key instead
  // of being swallowed by a substring rule below (M11).
  if (clean === "cursor" || clean === "acp-cursor") return "acp-cursor";
  if (clean.startsWith("acp-")) return clean;

  if (clean.includes("codex") || clean === "openai") return "codex";
  if (clean.includes("claude") || clean === "anthropic") return "provider-claude-code";
  if (clean.includes("antigravity") || clean === "agy" || clean === "provider-agy" || clean.includes("gemini"))
    return "agy";
  // Exact/prefix match only: a substring test pulled "openpipe" under Pi.
  if (clean === "pi" || clean === "provider-pi" || clean.startsWith("pi-") || clean.includes("inflection"))
    return "provider-pi";
  if (clean.includes("opencode")) return "opencode";
  return clean.replace(/\s+/g, "-");
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

function inferProviderFromModels(models: string[]): string {
  const sample = models.join(" ").toLowerCase();
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
  keyRemap?: Map<string, string>
): FavoritesMap {
  const result: FavoritesMap = {};
  if (!raw || typeof raw !== "object") return result;
  for (const [key, models] of Object.entries(raw)) {
    if (!Array.isArray(models) || models.length === 0) continue;
    let prov = normalizeProviderId(key);
    if (prov === PROVIDER_UNKNOWN) prov = inferProviderFromModels(models);
    keyRemap?.set(key, prov);

    const existing = result[prov] || [];
    for (const m of models) {
      if (typeof m !== "string") continue;
      const id = cleanModelText(m.trim());
      if (id && !existing.includes(id)) existing.push(id);
    }
    if (existing.length > 0) result[prov] = existing;
  }
  return result;
}

/**
 * Sanitize favorites and their display labels together so both move under the
 * same canonical provider keys (stored label keys are "provider:model").
 */
export function sanitizeStore(
  rawFavorites: FavoritesMap | null | undefined,
  rawLabels: ModelLabels | null | undefined
): { favorites: FavoritesMap; modelLabels: ModelLabels } {
  const remap = new Map<string, string>();
  const favorites = sanitizeFavoritesMap(rawFavorites, remap);

  const modelLabels: ModelLabels = {};
  if (rawLabels && typeof rawLabels === "object") {
    for (const [key, label] of Object.entries(rawLabels)) {
      if (typeof label !== "string") continue;
      const idx = key.indexOf(":");
      if (idx < 0) continue;
      const prov = remap.get(key.slice(0, idx)) ?? normalizeProviderId(key.slice(0, idx));
      const model = cleanModelText(key.slice(idx + 1));
      const text = cleanModelText(label);
      if (!model || !text) continue;
      modelLabels[`${prov}:${model}`] = text;
    }
  }
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
