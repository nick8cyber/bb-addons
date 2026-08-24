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

const STORAGE_KEY = "bb-plugin-favorite-models:v1";
const RPC_ENDPOINT = "/api/v1/plugins/favorite-models/rpc";

const DEFAULT_STATE: FavoritesState = {
  favorites: {},
  modelLabels: {},
  pinToTop: true,
  showQuickBar: true,
};

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
    return {
      favorites: typeof parsed.favorites === "object" && parsed.favorites !== null ? parsed.favorites : {},
      modelLabels: typeof parsed.modelLabels === "object" && parsed.modelLabels !== null ? parsed.modelLabels : {},
      pinToTop: typeof parsed.pinToTop === "boolean" ? parsed.pinToTop : true,
      showQuickBar: typeof parsed.showQuickBar === "boolean" ? parsed.showQuickBar : true,
    };
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
  return currentState.modelLabels[key] || modelId;
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
    const mergedFavorites = { ...res.favorites, ...currentState.favorites };
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
  });
}
