/** Optimistic client state derived from a confirmed server snapshot and the pending queue. */
import { toast } from "sonner";
import {
  cleanModelText,
  dropLabels,
  isValidFavoritesPayload,
  labelKey,
  migrateStore,
  normalizeModelKey,
  normalizeProviderId,
  resolvePickerProviderId,
  sanitizeStore,
  type FavoritesMap,
  type FavoritesSnapshot,
  type ModelLabels,
  type ProviderIdentity,
} from "./store.js";

export { cleanModelText };

type Config = { pinToTop: boolean; showQuickBar: boolean };
export interface FavoritesState extends Config {
  favorites: FavoritesMap;
  modelLabels: ModelLabels;
}

interface ServerSnapshot extends FavoritesSnapshot {
  config?: Partial<Config>;
  providers?: ProviderIdentity[];
}

const STORAGE_KEY = "bb-plugin-favorite-models:v2";
const QUEUE_KEY = "bb-plugin-favorite-models:pending:v1";
const RPC_ENDPOINT = "/api/v1/plugins/favorite-models/rpc";
const REFRESH_INTERVAL = 15_000;
const RETRY_DELAYS = [1_000, 3_000, 10_000];

const DEFAULT_STATE: FavoritesState = {
  favorites: {},
  modelLabels: {},
  pinToTop: true,
  showQuickBar: true,
};

type ModelInput = { providerId: string; modelId: string };
type Mutation =
  | { method: "addFavorite"; input: ModelInput & { label?: string } }
  | { method: "removeFavorite"; input: ModelInput }
  | { method: "clearFavorites"; input: { providerId: string | null } }
  | { method: "setFavorites"; input: Omit<FavoritesSnapshot, "version"> & { baseVersion: number } }
  | { method: "updateConfig"; input: Partial<Config> };

type Pending = {
  mutation: Mutation;
  attempts: number;
  resolve?: (ok: boolean) => void;
};

function safeStorage(name: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return typeof window !== "undefined" ? window[name] : null;
  } catch {
    return null;
  }
}

function loadInitialState(): FavoritesState {
  try {
    const raw = safeStorage("localStorage")?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return {
      ...migrateStore(parsed.favorites ?? {}, parsed.modelLabels ?? {}),
      pinToTop: typeof parsed.pinToTop === "boolean" ? parsed.pinToTop : true,
      showQuickBar: typeof parsed.showQuickBar === "boolean" ? parsed.showQuickBar : true,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function loadQueue(): Pending[] {
  try {
    const raw = safeStorage("sessionStorage")?.getItem(QUEUE_KEY);
    const entries: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) =>
      Number.isInteger(entry?.attempts) && entry.attempts >= 0 &&
      entry.mutation?.input && ["addFavorite", "removeFavorite", "clearFavorites", "setFavorites", "updateConfig"]
        .includes(entry.mutation.method)
    );
  } catch {
    return [];
  }
}

function saveQueue(): void {
  try {
    const storage = safeStorage("sessionStorage");
    if (pending.length) storage?.setItem(QUEUE_KEY, JSON.stringify(pending));
    else storage?.removeItem(QUEUE_KEY);
  } catch {
    // The in-memory queue remains usable when the browser blocks storage.
  }
}

let directory: readonly ProviderIdentity[] = [];
let confirmed = loadInitialState();
let serverVersion = 0;
let confirmedWrites = 0;
const pending = loadQueue();
const listeners = new Set<(state: FavoritesState) => void>();
let currentState = pending.reduce((state, entry) => applyMutation(state, entry.mutation), confirmed);

export function resolveProviderKey(provider: string): string {
  return normalizeProviderId(provider, directory);
}

export function resolvePickerProvider(label: string): string {
  return resolvePickerProviderId(label, directory);
}

export function getProviderDisplayName(providerId: string): string {
  const name = directory.find(({ id }) => id === providerId)?.displayName;
  if (name) return name;
  switch (providerId) {
    case "codex": return "Codex (OpenAI)";
    case "provider-claude-code":
    case "claude-code": return "Claude Code";
    case "agy": return "Antigravity (agy)";
    case "provider-pi": return "Pi";
    case "acp-opencode": return "OpenCode";
    case "acp-devin": return "Devin";
    case "acp-cursor": return "Cursor";
    case "acp-antigravity": return "Google Antigravity";
    case "acp-web-gemini": return "ACP Web Gemini";
    case "default": return "Текущий провайдер";
    default: return providerId.charAt(0).toUpperCase() + providerId.slice(1);
  }
}

export function subscribe(listener: (state: FavoritesState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getState(): FavoritesState {
  return currentState;
}

function applyMutation(state: FavoritesState, { method, input }: Mutation): FavoritesState {
  if (method === "updateConfig") return { ...state, ...input };
  if (method === "setFavorites") {
    return { ...state, ...sanitizeStore(input.favorites, input.modelLabels, directory) };
  }

  const favorites = { ...state.favorites };
  const provider = resolveProviderKey(input.providerId ?? "");
  if (method === "clearFavorites") {
    if (input.providerId === null) return { ...state, favorites: {}, modelLabels: {} };
    delete favorites[provider];
    return { ...state, favorites, modelLabels: dropLabels(state.modelLabels, provider) };
  }

  const id = input.modelId;
  const list = favorites[provider] ?? [];
  if (method === "addFavorite") {
    favorites[provider] = list.includes(id) ? list : [id, ...list];
    const modelLabels = input.label
      ? { ...state.modelLabels, [labelKey(provider, id)]: cleanModelText(input.label) }
      : state.modelLabels;
    return { ...state, favorites, modelLabels };
  }

  const rest = list.filter((model) => model !== id);
  if (rest.length > 0) favorites[provider] = rest;
  else delete favorites[provider];
  return { ...state, favorites, modelLabels: dropLabels(state.modelLabels, provider, id) };
}

function publish(force = false): void {
  const next = pending.reduce((state, entry) => applyMutation(state, entry.mutation), confirmed);
  if (!force && JSON.stringify(currentState) === JSON.stringify(next)) return;
  currentState = next;
  for (const listener of listeners) {
    try {
      listener(currentState);
    } catch (err) {
      console.error("[favorite-models] Listener error:", err);
    }
  }
}

function saveConfirmed(): void {
  try {
    safeStorage("localStorage")?.setItem(STORAGE_KEY, JSON.stringify(confirmed));
  } catch {
    // Server state is still authoritative when the browser cache is unavailable.
  }
}

function acceptSnapshot(snapshot: ServerSnapshot): boolean {
  if (typeof snapshot.version !== "number" || snapshot.version < serverVersion ||
      !snapshot.favorites || !snapshot.modelLabels) return false;
  serverVersion = snapshot.version;
  const directoryChanged = snapshot.providers !== undefined &&
    JSON.stringify(directory) !== JSON.stringify(snapshot.providers);
  if (snapshot.providers) directory = snapshot.providers;
  confirmed = {
    ...confirmed,
    ...sanitizeStore(snapshot.favorites, snapshot.modelLabels, directory),
    ...snapshot.config,
  };
  saveConfirmed();
  return directoryChanged;
}

type RpcResult<T> = { ok: true; result: T } | { ok: false; status: number };

async function callRpc<T>(method: string, input: unknown): Promise<RpcResult<T>> {
  let status = 0;
  try {
    const response = await fetch(`${RPC_ENDPOINT}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(8_000),
    });
    status = response.status ?? 0;
    const data = await response.json() as RpcResult<T>;
    return data.ok ? data : { ok: false, status: status || 400 };
  } catch {
    return { ok: false, status: status >= 400 ? status : 0 };
  }
}

let readGeneration = 0;
let activeRead: Promise<void> | undefined;

export function refreshFavorites(): Promise<void> {
  if (activeRead) return activeRead;
  const gen = readGeneration;
  const writesAtStart = confirmedWrites;
  activeRead = (async () => {
    let result = await callRpc<ServerSnapshot>("getFavorites", null);
    if (gen !== readGeneration) return;
    // A newer write may also change config without bumping favorites.version.
    const writesBeforeRetry = confirmedWrites;
    if (!result.ok || writesAtStart !== writesBeforeRetry) {
      result = await callRpc<ServerSnapshot>("getFavorites", null);
    }
    if (gen === readGeneration && confirmedWrites === writesBeforeRetry && result.ok) {
      publish(acceptSnapshot(result.result));
    }
  })().finally(() => {
    if (gen === readGeneration) activeRead = undefined;
  });
  return activeRead;
}

let inFlight = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let queuePaused = false;

function pumpQueue(force = false): void {
  if (queuePaused || inFlight || pending.length === 0 || (retryTimer && !force)) return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  inFlight = true;
  void sendMutation(pending[0]).finally(() => {
    inFlight = false;
    pumpQueue();
  });
}

async function sendMutation(entry: Pending): Promise<void> {
  const { method, input } = entry.mutation;
  type ConfigResult = { success: boolean; config: Config };
  const result = await callRpc<ServerSnapshot | ConfigResult>(method, input);
  const rejected = result.ok && "success" in result.result && !result.result.success;
  if (!result.ok) {
    const delay = RETRY_DELAYS[entry.attempts++];
    if ((result.status === 0 || result.status === 429 || result.status >= 500) && delay !== undefined) {
      saveQueue();
      if (!queuePaused) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          pumpQueue();
        }, delay);
      }
      return;
    }
  }

  pending.shift();
  saveQueue();
  if (result.ok && !rejected) {
    confirmedWrites++;
    if ("version" in result.result) {
      publish(acceptSnapshot(result.result));
    } else {
      confirmed = { ...confirmed, ...result.result.config };
      saveConfirmed();
      publish();
    }
    entry.resolve?.(true);
    return;
  }

  // Removing just this intent rolls it back while keeping later queued edits.
  publish();
  await refreshFavorites();
  toast.error(!result.ok && result.status === 409
    ? "Избранное изменилось на сервере. Проверьте список и повторите импорт."
    : "Сервер не подтвердил изменение. Список восстановлен по последним данным.");
  entry.resolve?.(false);
}

function enqueue(mutation: Mutation): Promise<boolean> {
  return new Promise((resolve) => {
    pending.push({ mutation, attempts: 0, resolve });
    queuePaused = false;
    saveQueue();
    publish();
    pumpQueue();
  });
}

export function isFavorite(providerId: string, modelId: string): boolean {
  return currentState.favorites[resolveProviderKey(providerId)]?.includes(modelId) ?? false;
}

export function getFavoritesForProvider(providerId: string): string[] {
  return [...(currentState.favorites[resolveProviderKey(providerId)] ?? [])];
}

export function getAllFavorites(): FavoritesMap {
  return { ...currentState.favorites };
}

export function getFavoritesCount(): number {
  return Object.values(currentState.favorites).reduce((count, list) => count + list.length, 0);
}

export function getModelLabel(providerId: string, modelId: string): string {
  return cleanModelText(currentState.modelLabels[labelKey(resolveProviderKey(providerId), modelId)] || modelId);
}

export function addFavorite(providerId: string, modelId: string, label?: string): Promise<boolean> {
  const prov = resolveProviderKey(providerId);
  const id = normalizeModelKey(modelId);
  if (prov === "default" || !id) return Promise.resolve(false);
  return enqueue({ method: "addFavorite", input: { providerId: prov, modelId: id, label } });
}

export function removeFavorite(providerId: string, modelId: string): Promise<boolean> {
  const prov = resolveProviderKey(providerId);
  const id = normalizeModelKey(modelId);
  if (prov === "default" || !id) return Promise.resolve(false);
  const list = currentState.favorites[prov] ?? [];
  // A manually entered bare key can still remove its routed counterpart.
  const storedId = list.includes(id) ? id : list.find((m) => m.startsWith(`${id} · `));
  return enqueue({ method: "removeFavorite", input: { providerId: prov, modelId: storedId ?? id } });
}

export function toggleFavorite(providerId: string, modelId: string, label?: string): Promise<boolean> {
  const prov = resolveProviderKey(providerId);
  const id = normalizeModelKey(modelId);
  if (prov === "default" || !id) return Promise.resolve(false);
  const head = id.split(" · ")[0];
  const stored = [id, head].find((key) => isFavorite(prov, key));
  return stored ? removeFavorite(prov, stored).then(() => false) : addFavorite(prov, id, label);
}

export function clearFavorites(providerId?: string): Promise<boolean> {
  const prov = providerId ? resolveProviderKey(providerId) : null;
  if (prov === "default") return Promise.resolve(false);
  return enqueue({ method: "clearFavorites", input: { providerId: prov } });
}

export function updateConfig(updates: Partial<Config>): Promise<boolean> {
  return enqueue({ method: "updateConfig", input: updates });
}

export function exportFavoritesJson(): string {
  return JSON.stringify({
    version: serverVersion,
    exportedAt: new Date().toISOString(),
    favorites: currentState.favorites,
    modelLabels: currentState.modelLabels,
  }, null, 2);
}

export function importFavoritesJson(jsonStr: string): Promise<boolean> {
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    // The structural check below handles parsing failures as well.
  }
  if (!isValidFavoritesPayload(data)) {
    toast.error("Неверный формат JSON");
    return Promise.resolve(false);
  }
  const store = sanitizeStore(data.favorites, data.modelLabels ?? {}, directory);
  return enqueue({ method: "setFavorites", input: { ...store, baseVersion: serverVersion } });
}

let stopSync: (() => void) | undefined;
export function initBackendSync(): () => void {
  stopSync?.();
  queuePaused = false;
  const wake = () => {
    pumpQueue();
    void refreshFavorites();
  };
  const visible = () => {
    if (document.visibilityState === "visible") wake();
  };
  const online = () => {
    pumpQueue(true);
    void refreshFavorites();
  };
  window.addEventListener("focus", wake);
  window.addEventListener("online", online);
  document.addEventListener("visibilitychange", visible);
  const interval = setInterval(visible, REFRESH_INTERVAL);
  wake();

  const dispose = () => {
    if (stopSync !== dispose) return;
    stopSync = undefined;
    readGeneration++;
    activeRead = undefined;
    queuePaused = true;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", online);
    document.removeEventListener("visibilitychange", visible);
    clearInterval(interval);
  };
  stopSync = dispose;
  return dispose;
}
