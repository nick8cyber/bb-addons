/**
 * orchestrator §18.4 (r32, PLUG-245): доверие по снимку исполняемых
 * настроек. Хешируются исполняемые поля слоёв release-конфига —
 * `postPublish.commands`, `checks`, `prProvider` с типом command
 * (eventHooks — PLUG-246, подключаются сюда же). Первый снимок —
 * молча; расхождение — предупреждение в лог и одна строка
 * координаторам с незавершёнными делегированиями/выкладками; имена и
 * хеши в `exec-settings-changes`, значения не печатаются.
 */
import { createHash } from "node:crypto";
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

/** §18.4: карта «ключ → хеш» исполняемых настроек. */
export function execSettingsFingerprint(
  cfg: ReleaseConfig | null,
): Record<string, string> {
  const out: Record<string, string> = {};
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

/** Имена изменённых ключей из последнего снимка (для status). */
export function execSettingsChangedKeys(store: DelegationStore): string[] {
  const raw = store.metaGet(CHANGES_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Сверить текущие исполняемые настройки со снимком. Первый снимок —
 * молча. При расхождении: снимок обновляется, список ключей пишется в
 * plugin_meta, warn в лог и по одной строке координаторам с активной
 * работой (делегирования dispatching/running, выкладки
 * auditing/publishing). Возвращает список расхождений.
 */
export async function checkExecSettings(deps: {
  store: DelegationStore;
  cfg: ReleaseConfig | null;
  send: (threadId: string, text: string) => Promise<void>;
  warn?: (m: string) => void;
}): Promise<ExecSettingsChange[]> {
  const next = execSettingsFingerprint(deps.cfg);
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
  const changes: ExecSettingsChange[] = [];
  for (const [k, v] of Object.entries(next)) {
    if (prev[k] !== v) changes.push({ key: k, prev: prev[k] ?? "", next: v });
  }
  for (const [k, v] of Object.entries(prev)) {
    if (!(k in next)) changes.push({ key: k, prev: v, next: "" });
  }
  if (!changes.length) return [];
  deps.store.metaSet(SNAPSHOT_KEY, JSON.stringify(next));
  deps.store.metaSet(CHANGES_KEY, JSON.stringify(changes.map((c) => c.key)));
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
