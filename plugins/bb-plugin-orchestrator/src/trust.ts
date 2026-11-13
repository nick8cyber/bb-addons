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

/** §18.5 (ревью заход 3): при битом документе `eventHooks` в снимок
 * вместо ключей хуков ложится этот маркер с хешем сырой строки —
 * NUL в имени не совпадает ни с одним допустимым именем хука,
 * поэтому переход «документ испорчен» виден как изменение, а не
 * как тишина. */
export const HOOKS_BROKEN_KEY = `${HOOKS_KEY_PREFIX}\0broken`;

export async function checkExecSettings(deps: {
  store: DelegationStore;
  cfg: ReleaseConfig | null;
  /** §18.5: действующие хуки — часть снимка доверия. */
  hooks?: readonly EventHookSetting[] | null;
  /** Документ `release` не парсится — его часть снимка не сверяем. */
  cfgBroken?: boolean;
  /** Документ `eventHooks` не парсится — хуки не запускаются, а в
   * снимок вместо ключей хуков ложится маркер `HOOKS_BROKEN_KEY` с
   * хешем `hooksRaw`: «хороший → битый» и каждая правка битого
   * документа видны, исправленный документ сравнивается с маркером
   * (ревью PLUG-246 заход 3). */
  hooksBroken?: boolean;
  /** Сырая строка настройки `eventHooks` — источник хеша маркера
   * `HOOKS_BROKEN_KEY` при `hooksBroken`. */
  hooksRaw?: string;
  send: (threadId: string, text: string) => Promise<void>;
  warn?: (m: string) => void;
}): Promise<ExecSettingsChange[]> {
  const next = execSettingsFingerprint(
    deps.cfgBroken ? null : deps.cfg,
    deps.hooksBroken ? null : deps.hooks,
  );
  // §18.5 (ревью заход 3): битый `eventHooks` — не перенос прежних
  // ключей (так «хороший → битый» был бы незаметен), а маркер с хешем
  // сырой строки: ключи хуков сняты, маркер добавлен, каждая правка
  // битого документа меняет хеш, исправление сравнивается с маркером.
  if (deps.hooksBroken) {
    next[HOOKS_BROKEN_KEY] = hashEntry(deps.hooksRaw ?? "");
  }
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
  // Сломанный `release` не отключает сверку хуков и не имитирует
  // «всё убрали»: его прежние ключи переносятся в снимок как есть.
  // Битый `eventHooks` так не обрабатываем — там маркер (выше), иначе
  // переход «хороший → битый» был бы незаметен.
  if (deps.cfgBroken) {
    for (const [k, v] of Object.entries(prev)) {
      if (!(k in next) && !k.startsWith(HOOKS_KEY_PREFIX)) next[k] = v;
    }
    deps.warn?.(
      "orchestrator: release-конфиг не парсится — эта часть снимка " +
        "исполняемых настроек не сверялась (прежние ключи сохранены)",
    );
  }
  if (deps.hooksBroken) {
    deps.warn?.(
      "orchestrator: eventHooks не парсится — хуки не запускаются; " +
        "в снимке доверия — маркер битого документа",
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
