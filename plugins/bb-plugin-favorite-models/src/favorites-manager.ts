/**
 * Favorites Manager: Durable client-side & RPC-synced store for favorited models.
 */

export interface FavoritesState {
  /** Map of providerId -> array of modelIds */
  favorites: Record<string, string[]>;
  /** Cache of model display labels: "providerId:modelId" -> string */
  modelLabels: Record<string, string>;
  /** Whether favorite models should be placed at the top of the dropdown */
  pinToTop: boolean;
  /** Whether the composer should show quick favorite action */
  showQuickBar: boolean;
}

const STORAGE_KEY = "bb-plugin-favorite-models:v2";
const RPC_ENDPOINT = "/api/v1/plugins/favorite-models/rpc";

const DEFAULT_STATE: FavoritesState = {
  favorites: {},
  modelLabels: {},
  pinToTop: true,
  showQuickBar: true,
};

/**
 * Strips keyboard-shortcut residue (e.g. "⇧-⌘-m", "Alt+M", "Ctrl+Shift+P")
 * that leaks into model labels captured from picker DOM.
 */
export function cleanModelText(text: string): string {
  let out = (text || "")
    .replace(/\s*(⇧|⌘|⌥|⌃)([+\s\-]*(⇧|⌘|⌥|⌃|[a-zа-я0-9]))*/gi, "")
    .replace(/\s*\b(ctrl|control|alt|option|shift|cmd|meta)\b([+\-][a-z0-9]+)+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Drop trailing dangling separators like "-" or "·"
  out = out.replace(/[\s·\-]+$/g, "").trim();
  return out;
}

export function getProviderDisplayName(providerId: string): string {
  const clean = (providerId || "").toLowerCase().trim();
  switch (clean) {
    case "codex":
      return "Codex (OpenAI)";
    case "provider-claude-code":
    case "claude-code":
    case "claude":
      return "Claude Code (Anthropic)";
    case "agy":
    case "provider-agy":
    case "antigravity":
      return "Antigravity (AGY)";
    case "provider-pi":
    case "pi":
      return "Pi (Inflection)";
    case "opencode":
      return "OpenCode";
    case "acp-cursor":
      return "Cursor";
    case "default":
      return "Текущий провайдер";
    default:
      if (clean.includes("⌘") || clean.includes("⇧") || clean.includes("alt") || clean.includes("ctrl")) {
        return "Другие";
      }
      return providerId.charAt(0).toUpperCase() + providerId.slice(1);
  }
}

export function sanitizeFavoritesMap(raw: Record<string, string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, models] of Object.entries(raw || {})) {
    if (!Array.isArray(models) || models.length === 0) continue;
    let prov = key.trim().toLowerCase();

    // Normalize keys that captured model text: "kilo-gateway/auto-free" -> "kilo-gateway"
    if (prov.includes("/")) {
      prov = prov.split("/")[0].trim();
    }

    // If key contains shortcut characters or garbage, infer provider from model names or map to claude
    if (
      prov.includes("⌘") ||
      prov.includes("⇧") ||
      prov.includes("alt") ||
      prov.includes("ctrl") ||
      prov.includes("shift")
    ) {
      const sample = models.join(" ").toLowerCase();
      if (sample.includes("gpt") || sample.includes("o1") || sample.includes("o3") || sample.includes("o4")) {
        prov = "codex";
      } else if (sample.includes("gemini")) {
        prov = "agy";
      } else {
        prov = "provider-claude-code";
      }
    } else if (prov.includes("codex") || prov === "openai") {
      prov = "codex";
    } else if (prov.includes("claude") || prov === "anthropic") {
      prov = "provider-claude-code";
    } else if (prov.includes("antigravity") || prov === "agy" || prov.includes("gemini")) {
      prov = "agy";
    } else if (prov.includes("pi")) {
      prov = "provider-pi";
    }

    const existing = result[prov] || [];
    for (const m of models) {
      if (typeof m === "string" && m.trim() && !existing.includes(m.trim())) {
        existing.push(m.trim());
      }
    }
    result[prov] = existing;
  }
  return result;
}

let currentState: FavoritesState = loadInitialState();
const listeners = new Set<(state: FavoritesState) => void>();

function loadInitialState(): FavoritesState {
  if (typeof window === "undefined" || !window.localStorage) {
    return { ...DEFAULT_STATE };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    const favs = typeof parsed.favorites === "object" && parsed.favorites !== null ? parsed.favorites : {};
    const favorites = sanitizeFavoritesMap(favs);
    const modelLabels =
      typeof parsed.modelLabels === "object" && parsed.modelLabels !== null ? parsed.modelLabels : {};

    // Migration: strip shortcut residue from stored model ids/labels and
    // drop favorites whose id was pure shortcut garbage.
    let needsRewrite = false;
    for (const [prov, list] of Object.entries(favorites)) {
      const cleaned: string[] = [];
      for (const id of list) {
        const c = cleanModelText(id);
        if (!c) {
          needsRewrite = true;
          continue;
        }
        if (c !== id) needsRewrite = true;
        if (!cleaned.includes(c)) cleaned.push(c);
      }
      if (cleaned.length === 0) delete favorites[prov];
      else favorites[prov] = cleaned;
    }
    for (const [key, label] of Object.entries(modelLabels)) {
      if (typeof label !== "string") continue;
      const c = cleanModelText(label);
      if (c !== label) {
        modelLabels[key] = c;
        needsRewrite = true;
      }
    }

    const nextState: FavoritesState = {
      favorites,
      modelLabels,
      pinToTop: typeof parsed.pinToTop === "boolean" ? parsed.pinToTop : true,
      showQuickBar: typeof parsed.showQuickBar === "boolean" ? parsed.showQuickBar : true,
    };
    if (needsRewrite) persistState(nextState);
    return nextState;
  } catch (err) {
    console.warn("[favorite-models] Error reading localStorage:", err);
    return { ...DEFAULT_STATE };
  }
}

function persistState(state: FavoritesState): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("[favorite-models] Error writing to localStorage:", err);
  }
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener(currentState);
    } catch (err) {
      console.error("[favorite-models] Listener error:", err);
    }
  }
}

async function callRpc<T>(method: string, input: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${RPC_ENDPOINT}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as { ok: true; result: T } | { ok: false; error: unknown };
    return data.ok ? data.result : null;
  } catch {
    return null;
  }
}

export function subscribe(listener: (state: FavoritesState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): FavoritesState {
  return currentState;
}

export function isFavorite(providerId: string, modelId: string): boolean {
  if (!providerId || !modelId) return false;
  const list = currentState.favorites[providerId];
  if (!list || !Array.isArray(list)) return false;
  return list.includes(modelId);
}

export function getFavoritesForProvider(providerId: string): string[] {
  if (!providerId) return [];
  const list = currentState.favorites[providerId];
  return Array.isArray(list) ? [...list] : [];
}

export function getAllFavorites(): Record<string, string[]> {
  return { ...currentState.favorites };
}

export function getFavoritesCount(): number {
  let count = 0;
  for (const list of Object.values(currentState.favorites)) {
    if (Array.isArray(list)) count += list.length;
  }
  return count;
}

export function getModelLabel(providerId: string, modelId: string): string {
  const key = `${providerId}:${modelId}`;
  return cleanModelText(currentState.modelLabels[key] || modelId);
}

export function toggleFavorite(providerId: string, modelId: string, label?: string): boolean {
  if (!providerId || !modelId) return false;
  const currentList = currentState.favorites[providerId] || [];
  const exists = currentList.includes(modelId);

  let nextList: string[];
  if (exists) {
    nextList = currentList.filter((id) => id !== modelId);
  } else {
    nextList = [modelId, ...currentList.filter((id) => id !== modelId)];
  }

  const nextFavorites = { ...currentState.favorites };
  if (nextList.length === 0) {
    delete nextFavorites[providerId];
  } else {
    nextFavorites[providerId] = nextList;
  }

  const nextLabels = { ...currentState.modelLabels };
  if (label) {
    nextLabels[`${providerId}:${modelId}`] = label;
  }

  currentState = {
    ...currentState,
    favorites: nextFavorites,
    modelLabels: nextLabels,
  };

  persistState(currentState);
  notify();

  // Async sync with backend
  void callRpc("toggleFavorite", { providerId, modelId, label });

  return !exists;
}

export function addFavorite(providerId: string, modelId: string, label?: string): void {
  if (!providerId || !modelId) return;
  const currentList = currentState.favorites[providerId] || [];
  if (currentList.includes(modelId)) return;

  const nextFavorites = {
    ...currentState.favorites,
    [providerId]: [modelId, ...currentList],
  };

  const nextLabels = { ...currentState.modelLabels };
  if (label) {
    nextLabels[`${providerId}:${modelId}`] = label;
  }

  currentState = {
    ...currentState,
    favorites: nextFavorites,
    modelLabels: nextLabels,
  };

  persistState(currentState);
  notify();

  void callRpc("toggleFavorite", { providerId, modelId, label });
}

export function removeFavorite(providerId: string, modelId: string): void {
  if (!providerId || !modelId) return;
  const currentList = currentState.favorites[providerId] || [];
  if (!currentList.includes(modelId)) return;

  const nextList = currentList.filter((id) => id !== modelId);
  const nextFavorites = { ...currentState.favorites };
  if (nextList.length === 0) {
    delete nextFavorites[providerId];
  } else {
    nextFavorites[providerId] = nextList;
  }

  currentState = {
    ...currentState,
    favorites: nextFavorites,
  };

  persistState(currentState);
  notify();

  void callRpc("toggleFavorite", { providerId, modelId });
}

export function clearFavorites(providerId?: string): void {
  let nextFavorites: Record<string, string[]>;
  if (providerId) {
    nextFavorites = { ...currentState.favorites };
    delete nextFavorites[providerId];
  } else {
    nextFavorites = {};
  }

  currentState = {
    ...currentState,
    favorites: nextFavorites,
  };

  persistState(currentState);
  notify();

  void callRpc("clearFavorites", { providerId: providerId ?? null });
}

export function updateConfig(updates: Partial<Pick<FavoritesState, "pinToTop" | "showQuickBar">>): void {
  currentState = {
    ...currentState,
    ...updates,
  };
  persistState(currentState);
  notify();

  void callRpc("updateConfig", updates);
}

export function exportFavoritesJson(): string {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      favorites: currentState.favorites,
      modelLabels: currentState.modelLabels,
    },
    null,
    2
  );
}

export function importFavoritesJson(jsonStr: string): boolean {
  try {
    const data = JSON.parse(jsonStr);
    if (!data || typeof data.favorites !== "object") return false;

    currentState = {
      ...currentState,
      favorites: data.favorites,
      modelLabels: typeof data.modelLabels === "object" ? data.modelLabels : currentState.modelLabels,
    };
    persistState(currentState);
    notify();

    void callRpc("setFavorites", {
      favorites: currentState.favorites,
      modelLabels: currentState.modelLabels,
    });
    return true;
  } catch (err) {
    console.error("[favorite-models] Import failed:", err);
    return false;
  }
}

/**
 * Initialize sync with backend RPC on boot.
 */
export function initBackendSync(): void {
  void callRpc<{
    favorites: Record<string, string[]>;
    modelLabels: Record<string, string>;
    config: { pinToTop: boolean; showQuickBar: boolean };
  }>("getFavorites", null).then((res) => {
    if (!res) return;
    const mergedFavorites = sanitizeFavoritesMap({ ...res.favorites, ...currentState.favorites });
    const mergedLabels = { ...res.modelLabels, ...currentState.modelLabels };
    currentState = {
      ...currentState,
      favorites: mergedFavorites,
      modelLabels: mergedLabels,
      pinToTop: res.config?.pinToTop ?? currentState.pinToTop,
      showQuickBar: res.config?.showQuickBar ?? currentState.showQuickBar,
    };
    persistState(currentState);
    notify();

    // If backend had shortcut keys like ⇧-⌘-m, update backend with clean sanitized map
    if (Object.keys(res.favorites || {}).some((k) => k.includes("⌘") || k.includes("⇧"))) {
      void callRpc("setFavorites", {
        favorites: mergedFavorites,
        modelLabels: mergedLabels,
      });
    }
  });
}
