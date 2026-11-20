/**
 * Favorites Manager: Durable client-side & RPC-synced store for favorited models.
 */
import {
  cleanModelText,
  dropLabels,
  isValidFavoritesPayload,
  labelKey,
  normalizeProviderId,
  sanitizeStore,
  type FavoritesMap,
  type ModelLabels,
} from "./store.js";

export { cleanModelText, normalizeProviderId };

export interface FavoritesState {
  /** Map of providerId -> array of modelIds */
  favorites: FavoritesMap;
  /** Cache of model display labels: "providerId:modelId" -> string */
  modelLabels: ModelLabels;
  /** Whether favorite models should be placed at the top of the dropdown */
  pinToTop: boolean;
  /** Whether the composer should show quick favorite action */
  showQuickBar: boolean;
}

interface ServerSnapshot {
  version: number;
  favorites: FavoritesMap;
  modelLabels: ModelLabels;
  config?: { pinToTop?: boolean; showQuickBar?: boolean };
}

const STORAGE_KEY = "bb-plugin-favorite-models:v2";
const RPC_ENDPOINT = "/api/v1/plugins/favorite-models/rpc";

const DEFAULT_STATE: FavoritesState = {
  favorites: {},
  modelLabels: {},
  pinToTop: true,
  showQuickBar: true,
};

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
      return providerId.charAt(0).toUpperCase() + providerId.slice(1);
  }
}

/**
 * Reading `window.localStorage` itself can throw in restricted browsing
 * contexts (data: documents, blocked storage) — access it only through this
 * guarded getter so module init never blows up (m5).
 */
function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

let currentState: FavoritesState = loadInitialState();
const listeners = new Set<(state: FavoritesState) => void>();

function loadInitialState(): FavoritesState {
  const storage = safeLocalStorage();
  if (!storage) {
    return { ...DEFAULT_STATE };
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    const { favorites, modelLabels } = sanitizeStore(
      typeof parsed.favorites === "object" ? parsed.favorites : {},
      typeof parsed.modelLabels === "object" ? parsed.modelLabels : {}
    );

    const nextState: FavoritesState = {
      favorites,
      modelLabels,
      pinToTop: typeof parsed.pinToTop === "boolean" ? parsed.pinToTop : true,
      showQuickBar: typeof parsed.showQuickBar === "boolean" ? parsed.showQuickBar : true,
    };
    if (JSON.stringify(parsed.favorites) !== JSON.stringify(favorites)) {
      persistState(nextState);
    }
    return nextState;
  } catch (err) {
    console.warn("[favorite-models] Error reading localStorage:", err);
    return { ...DEFAULT_STATE };
  }
}

function persistState(state: FavoritesState): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
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

/**
 * Version of the last server snapshot this client applied. A boot-time
 * `getFavorites` response that predates a locally applied mutation must not
 * roll the store back (M8); mutation responses carry the newest version.
 */
let serverVersion = 0;
/** Bumped on every optimistic local mutation, in-flight or not. */
let mutationCounter = 0;

function applyServerSnapshot(res: ServerSnapshot): void {
  if (typeof res.version === "number" && res.version < serverVersion) return;
  if (typeof res.version === "number") serverVersion = res.version;
  const { favorites, modelLabels } = sanitizeStore(res.favorites, res.modelLabels);
  currentState = {
    ...currentState,
    favorites,
    modelLabels,
    pinToTop: res.config?.pinToTop ?? currentState.pinToTop,
    showQuickBar: res.config?.showQuickBar ?? currentState.showQuickBar,
  };
  persistState(currentState);
  notify();
}

function commitLocal(next: FavoritesState): void {
  mutationCounter++;
  currentState = next;
  persistState(currentState);
  notify();
}

/**
 * Run an optimistic mutation, then hand control to the server answer:
 * - ok → the returned authoritative snapshot is applied (M9: callers no
 *   longer fire-and-forget, and add/remove are intent-explicit so a stale
 *   tab can never invert an existing entry);
 * - failed → reconcile by pulling getFavorites once; only if that also fails
 *   do we keep the optimistic state (offline fallback).
 */
async function runMutation(
  optimistic: () => void,
  rpc: () => Promise<ServerSnapshot | null>
): Promise<boolean> {
  optimistic();
  const res = await rpc();
  if (res) {
    applyServerSnapshot(res);
    return true;
  }
  const fresh = await callRpc<ServerSnapshot>("getFavorites", null);
  if (fresh) applyServerSnapshot(fresh);
  return false;
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

export function getAllFavorites(): FavoritesMap {
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
  return cleanModelText(currentState.modelLabels[labelKey(providerId, modelId)] || modelId);
}

export function addFavorite(providerId: string, modelId: string, label?: string): Promise<boolean> {
  const prov = normalizeProviderId(providerId);
  const id = cleanModelText(modelId.trim());
  if (!prov || prov === "default" || !id) return Promise.resolve(false);
  if ((currentState.favorites[prov] || []).includes(id)) return Promise.resolve(true);

  return runMutation(
    () => {
      const nextLabels = { ...currentState.modelLabels };
      if (label) nextLabels[labelKey(prov, id)] = cleanModelText(label);
      commitLocal({
        ...currentState,
        favorites: {
          ...currentState.favorites,
          [prov]: [id, ...(currentState.favorites[prov] || [])],
        },
        modelLabels: nextLabels,
      });
    },
    () => callRpc<ServerSnapshot>("addFavorite", { providerId: prov, modelId: id, label })
  );
}

export function removeFavorite(providerId: string, modelId: string): Promise<boolean> {
  const prov = normalizeProviderId(providerId);
  const id = modelId.trim();
  const list = currentState.favorites[prov] || [];
  // Match the stored key directly; also allow callers holding the display
  // part of a "model · route" key to remove it (star click always passes the
  // stored key verbatim, so this is only a manual-input convenience).
  const storedId = list.includes(id) ? id : list.find((m) => m === id || m.startsWith(`${id} · `));
  if (!storedId) return Promise.resolve(true);

  return runMutation(
    () => {
      const rest = list.filter((m) => m !== storedId);
      const nextFavorites = { ...currentState.favorites };
      if (rest.length === 0) delete nextFavorites[prov];
      else nextFavorites[prov] = rest;
      commitLocal({
        ...currentState,
        favorites: nextFavorites,
        modelLabels: dropLabels(currentState.modelLabels, prov, storedId),
      });
    },
    () => callRpc<ServerSnapshot>("removeFavorite", { providerId: prov, modelId: storedId })
  );
}

export function toggleFavorite(providerId: string, modelId: string, label?: string): Promise<boolean> {
  const prov = normalizeProviderId(providerId);
  const id = cleanModelText(modelId.trim());
  if (!prov || prov === "default" || !id) return Promise.resolve(false);
  return isFavorite(prov, id)
    ? removeFavorite(prov, id).then(() => false)
    : addFavorite(prov, id, label).then(() => true);
}

export function clearFavorites(providerId?: string): Promise<boolean> {
  const prov = providerId ? normalizeProviderId(providerId) : undefined;
  if (prov === "default") return Promise.resolve(false);
  return runMutation(
    () =>
      commitLocal(
        prov
          ? {
              ...currentState,
              favorites: Object.fromEntries(
                Object.entries(currentState.favorites).filter(([p]) => p !== prov)
              ),
              modelLabels: dropLabels(currentState.modelLabels, prov),
            }
          : { ...currentState, favorites: {}, modelLabels: {} }
      ),
    () => callRpc<ServerSnapshot>("clearFavorites", { providerId: prov ?? null })
  );
}

export function updateConfig(
  updates: Partial<Pick<FavoritesState, "pinToTop" | "showQuickBar">>
): Promise<boolean> {
  commitLocal({ ...currentState, ...updates });
  return callRpc<{ success: boolean; config: { pinToTop: boolean; showQuickBar: boolean } }>(
    "updateConfig",
    updates
  ).then((res) => {
    if (res?.config) {
      currentState = {
        ...currentState,
        pinToTop: res.config.pinToTop,
        showQuickBar: res.config.showQuickBar,
      };
      persistState(currentState);
      notify();
      return true;
    }
    return false;
  });
}

export function exportFavoritesJson(): string {
  return JSON.stringify(
    {
      version: serverVersion,
      exportedAt: new Date().toISOString(),
      favorites: currentState.favorites,
      modelLabels: currentState.modelLabels,
    },
    null,
    2
  );
}

export function importFavoritesJson(jsonStr: string): Promise<boolean> {
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return Promise.resolve(false);
  }
  // Validate the payload shape BEFORE touching the store or cache (M12).
  if (!isValidFavoritesPayload(data)) return Promise.resolve(false);
  const { favorites, modelLabels } = sanitizeStore(data.favorites, data.modelLabels ?? {});

  return runMutation(
    () =>
      commitLocal({
        ...currentState,
        favorites,
        modelLabels,
      }),
    () => callRpc<ServerSnapshot>("setFavorites", { favorites, modelLabels })
  );
}

/**
 * Initialize sync with backend RPC on boot.
 *
 * The server copy is authoritative: every client converges on it, so
 * favorites made on one device appear on the others. localStorage is only
 * a fast-start snapshot and an offline fallback — it never overrides the
 * server state on boot.
 *
 * The returned snapshot is applied only while no local mutation has happened
 * since the request was issued AND its version is not older than the last
 * applied server version — a late answer can never erase a newer star (M8).
 * Returns a disposer: remounts cancel their predecessor instead of stacking
 * another unguarded fetch.
 */
let syncGen = 0;
export function initBackendSync(): () => void {
  const gen = ++syncGen;
  const mutationsAtStart = mutationCounter;
  void callRpc<ServerSnapshot>("getFavorites", null).then((res) => {
    if (!res || gen !== syncGen) return;
    if (mutationCounter !== mutationsAtStart) return;
    if (typeof res.version === "number" && res.version < serverVersion) return;
    applyServerSnapshot(res);
  });
  return () => {
    if (gen === syncGen) syncGen++;
  };
}
