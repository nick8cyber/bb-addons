/**
 * orchestrator §18.4/§18.5 (r32): доверие по снимку исполняемых
 * настроек. Хешируются исполняемые поля слоёв release-конфига —
 * `postPublish.commands`, `checks`, `prProvider` с типом command — и
 * хуки событий `eventHooks` (PLUG-246, контекст `plugin:` — настройка
 * уровня плагина, не слоя проекта). Первый снимок — молча; расхождение
 * — предупреждение в лог и одна строка координаторам с незавершёнными
 * делегированиями/выкладками; имена и хеши в `exec-settings-changes`,
 * значения не печатаются.
 */
import { createHash } from "node:crypto";
import type { EventHookSetting } from "./events.js";
import type { ReleaseConfig, ReleaseProjectLayer } from "./release-config.js";
import { ACTIVE_STATUSES } from "./store.js";
import type { DelegationStore } from "./store.js";

const SNAPSHOT_KEY = "exec-snapshot";
const CHANGES_KEY = "exec-settings-changes";

export interface ExecSettingsChange {
  /** "<контекст>:<поле>:<имя>" — контекст defaults или id проекта. */
  key: string;
  prev: string;
  next: string;
}

const hashEntry = (v: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(v) ?? "")
    .digest("hex")
    .slice(0, 16);

/** §18.4/§18.5: карта «ключ → хеш» исполняемых настроек. Хуки —
 * контекст `plugin` (настройка плагина, а не слой release-конфига). */
export function execSettingsFingerprint(
  cfg: ReleaseConfig | null,
  hooks?: readonly EventHookSetting[] | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of hooks ?? []) {
    out[`${HOOKS_KEY_PREFIX}${h.name}`] = hashEntry(h);
  }
  if (!cfg) return out;
  const layer = (ctx: string, l: ReleaseProjectLayer) => {
    for (const c of l.postPublish?.commands ?? []) {
      out[`${ctx}:postPublish.commands:${c.name}`] = hashEntry(c);
    }
    (l.checks ?? []).forEach((c, i) => {
      out[`${ctx}:checks[${i}]`] = hashEntry(c);
    });
    if (l.prProvider?.type === "command") {
      out[`${ctx}:prProvider`] = hashEntry(l.prProvider.raw);
    }
  };
  layer("defaults", cfg.defaults);
  for (const [id, l] of Object.entries(cfg.projects)) layer(id, l);
  return out;
}

/** §18.4: записи «имя + хеши» из последнего снимка (для status;
 * значения настроек не печатаются). */
export function execSettingsChanges(
  store: DelegationStore,
): ExecSettingsChange[] {
  const raw = store.metaGet(CHANGES_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .map((e): ExecSettingsChange | null => {
        if (typeof e === "string") return { key: e, prev: "", next: "" };
        if (e && typeof e === "object" && "key" in e) {
          const o = e as Record<string, unknown>;
          return {
            key: String(o.key),
            prev: String(o.prev ?? ""),
            next: String(o.next ?? ""),
          };
        }
        return null;
      })
      .filter((e): e is ExecSettingsChange => e !== null);
  } catch {
    return [];
  }
}

/** Имена изменённых ключей из последнего снимка. */
export function execSettingsChangedKeys(store: DelegationStore): string[] {
  return execSettingsChanges(store).map((c) => c.key);
}

/**
 * Сверить текущие исполняемые настройки со снимком. Первый снимок —
 * молча. При расхождении: снимок обновляется, список ключей пишется в
 * plugin_meta, warn в лог и по одной строке координаторам с активной
 * работой (делегирования dispatching/running, выкладки
 * auditing/publishing). Возвращает список расхождений.
 */
/** Префикс ключей хуков в снимке — граница между частью `eventHooks`
 * и частью `release` при покомпонентной сверке. */
export const HOOKS_KEY_PREFIX = "plugin:eventHooks:";

export async function checkExecSettings(deps: {
  store: DelegationStore;
  cfg: ReleaseConfig | null;
  /** §18.5: действующие хуки — часть снимка доверия. */
  hooks?: readonly EventHookSetting[] | null;
  /** Документ `release` не парсится — его часть снимка не сверяем. */
  cfgBroken?: boolean;
  /** Документ `eventHooks` не парсится — сверка хуков пропускается,
   * но прежние ключи этой части из снимка НЕ стираются: пустой
   * fingerprint выглядел бы как «всё убрали» и рассылал бы ложные
   * уведомления; исправление документа сравнивается с настоящими
   * прежними значениями (ревью PLUG-246 Б2). */
  hooksBroken?: boolean;
  send: (threadId: string, text: string) => Promise<void>;
  warn?: (m: string) => void;
}): Promise<ExecSettingsChange[]> {
  const next = execSettingsFingerprint(
    deps.cfgBroken ? null : deps.cfg,
    deps.hooksBroken ? null : deps.hooks,
  );
  const prevRaw = deps.store.metaGet(SNAPSHOT_KEY);
  if (prevRaw === undefined) {
    deps.store.metaSet(SNAPSHOT_KEY, JSON.stringify(next));
    return [];
  }
  let prev: Record<string, string> = {};
  try {
    prev = JSON.parse(prevRaw) as Record<string, string>;
  } catch {
    /* битый снимок — как первый */
  }
  // Сломанная часть не отключает сверку остальных и не имитирует
  // «всё убрали»: её прежние ключи переносятся в снимок как есть.
  if (deps.cfgBroken || deps.hooksBroken) {
    const brokenPart = (k: string): boolean =>
      (!!deps.hooksBroken && k.startsWith(HOOKS_KEY_PREFIX)) ||
      (!!deps.cfgBroken && !k.startsWith(HOOKS_KEY_PREFIX));
    for (const [k, v] of Object.entries(prev)) {
      if (!(k in next) && brokenPart(k)) next[k] = v;
    }
    const what = [
      deps.cfgBroken ? "release-конфиг" : "",
      deps.hooksBroken ? "eventHooks" : "",
    ]
      .filter(Boolean)
      .join(" и ");
    deps.warn?.(
      `orchestrator: ${what} не парсится — эта часть снимка ` +
        `исполняемых настроек не сверялась (прежние ключи сохранены)`,
    );
  }
  const changes: ExecSettingsChange[] = [];
  for (const [k, v] of Object.entries(next)) {
    if (prev[k] !== v) changes.push({ key: k, prev: prev[k] ?? "", next: v });
  }
  for (const [k, v] of Object.entries(prev)) {
    if (!(k in next)) changes.push({ key: k, prev: v, next: "" });
  }
  if (!changes.length) return [];
  deps.store.metaSet(SNAPSHOT_KEY, JSON.stringify(next));
  deps.store.metaSet(CHANGES_KEY, JSON.stringify(changes));
  const names = changes.map((c) => c.key).join(", ");
  deps.warn?.(`orchestrator: изменены исполняемые настройки: ${names}`);
  const coords = new Set<string>();
  for (const d of deps.store.listByStatuses(ACTIVE_STATUSES)) {
    coords.add(d.coordinator_thread_id);
  }
  for (const r of deps.store.releasesByStatuses(["auditing", "publishing"])) {
    coords.add(r.coordinator_thread_id);
  }
  for (const t of coords) {
    await deps
      .send(t, `изменены исполняемые настройки: ${names}`)
      .catch(() => {});
  }
  return changes;
}
