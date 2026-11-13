/**
 * orchestrator §18.5 (r32, PLUG-246): хуки событий — настройка
 * `eventHooks` (`hooks` занято git-хуками), таблица `events` и
 * сопоставление события с хуками — в store.ts (та же транзакция, что и
 * переход). Здесь — разбор настройки и `notifyOnFail`: одна строка
 * координатору на серию сбоев, следующая только после успешного
 * запуска этого хука.
 */
import type { PolicyIssue } from "./policy.js";
import type {
  CommandRunRow,
  CommandRunStatus,
  DelegationStore,
} from "./store.js";

/** §18.5: один хук — `[{name, on:[…], run:[…], projects?, timeoutSec?, notifyOnFail?}]`. */
export interface EventHookSetting {
  name: string;
  on: string[];
  run: string[];
  projects?: string[];
  timeoutSec?: number;
  notifyOnFail?: boolean;
}

export interface EventHooksLoad {
  hooks: EventHookSetting[];
  errors: PolicyIssue[];
}

/** §18.5: таблица переходов v1 — события, которые плагин порождает. */
export const EVENT_KINDS = [
  "delegation.done",
  "delegation.failed",
  "delegation.stalled",
  "review.verdict",
  "release.published",
  "release.rejected",
  "release.failed",
  "pr.merged",
  "pr.closed",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((x) => typeof x === "string" && x.length > 0);

/**
 * Разбор настройки `eventHooks` — JSON-массив хуков. Пустая строка —
 * хуков нет. Невалидный документ — `errors` (needs-configuration как у
 * `release` не ставим: хуки — дополнительная функция, битая запись
 * пропускается и ложится в журнал).
 */
export function parseEventHooks(raw: string | undefined): EventHooksLoad {
  const errors: PolicyIssue[] = [];
  const hooks: EventHookSetting[] = [];
  if (raw === undefined || raw.trim() === "") return { hooks, errors };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    errors.push({
      path: "eventHooks",
      message: `не JSON: ${(e as Error).message}`,
    });
    return { hooks, errors };
  }
  if (!Array.isArray(doc)) {
    errors.push({ path: "eventHooks", message: "ожидается массив хуков" });
    return { hooks, errors };
  }
  doc.forEach((item, i) => {
    const path = `eventHooks[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ path, message: "хук — объект" });
      return;
    }
    const h = item as Record<string, unknown>;
    if (typeof h.name !== "string" || h.name.trim() === "") {
      errors.push({ path: `${path}.name`, message: "имя хука — строка" });
      return;
    }
    if (!isStrArr(h.on)) {
      errors.push({
        path: `${path}.on`,
        message: "on — непустой массив имён событий",
      });
      return;
    }
    if (!isStrArr(h.run)) {
      errors.push({
        path: `${path}.run`,
        message: "run — непустой массив argv (без shell)",
      });
      return;
    }
    if (h.projects !== undefined && !isStrArr(h.projects)) {
      errors.push({
        path: `${path}.projects`,
        message: "projects — массив id проектов",
      });
      return;
    }
    if (
      h.timeoutSec !== undefined &&
      (!Number.isInteger(h.timeoutSec) ||
        (h.timeoutSec as number) < 1 ||
        (h.timeoutSec as number) > 3600)
    ) {
      errors.push({
        path: `${path}.timeoutSec`,
        message: "timeoutSec — целое 1…3600",
      });
      return;
    }
    if (h.notifyOnFail !== undefined && typeof h.notifyOnFail !== "boolean") {
      errors.push({
        path: `${path}.notifyOnFail`,
        message: "notifyOnFail — boolean",
      });
      return;
    }
    hooks.push({
      name: h.name.trim(),
      on: [...(h.on as string[])],
      run: [...(h.run as string[])],
      ...(h.projects !== undefined
        ? { projects: [...(h.projects as string[])] }
        : {}),
      ...(h.timeoutSec !== undefined
        ? { timeoutSec: h.timeoutSec as number }
        : {}),
      ...(h.notifyOnFail !== undefined
        ? { notifyOnFail: h.notifyOnFail }
        : {}),
    });
  });
  return { hooks, errors };
}

/** Ключ серии сбоев — по имени хука (§18.5: следующая строка только
 * после успешного запуска этого хука). */
const FAIL_SERIES_KEY = "hook-fail-series";

function readFailSeries(store: DelegationStore): Record<string, true> {
  try {
    const v = JSON.parse(
      store.metaGet(FAIL_SERIES_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const out: Record<string, true> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

export interface HookFinishDeps {
  store: DelegationStore;
  send: (threadId: string, text: string) => Promise<void>;
  warn?: (msg: string) => void;
}

/**
 * §18.5 notifyOnFail: итог журнальной записи хука. Успех снимает серию
 * сбоев; сбой при поднятом флаге — молча, при снятом — одна строка
 * координатору «хук <name> на <событие> упал: <итог>». Координатор и
 * имя события — из stdin записи (JSON события v1), так строка не
 * зависит от текущей настройки (хук могли переименовать или убрать).
 */
export function onHookRunFinished(
  deps: HookFinishDeps,
  row: CommandRunRow,
  status: CommandRunStatus,
  outputTail: string,
): void {
  if (row.source !== "hook") return;
  const series = readFailSeries(deps.store);
  if (status === "ok") {
    if (row.name in series) {
      delete series[row.name];
      deps.store.metaSet(FAIL_SERIES_KEY, JSON.stringify(series));
    }
    return;
  }
  // skipped — «настройка сменилась», не сбой хука; у хуков не бывает,
  // но не даём ему шуметь, если появится.
  if (status === "skipped" || !row.notify_on_fail) return;
  if (row.name in series) return;
  let event = "";
  let coordinator = "";
  try {
    const payload = JSON.parse(row.stdin ?? "{}") as {
      event?: unknown;
      coordinatorThreadId?: unknown;
    };
    event = typeof payload.event === "string" ? payload.event : "";
    coordinator =
      typeof payload.coordinatorThreadId === "string"
        ? payload.coordinatorThreadId
        : "";
  } catch {
    /* битый stdin — строки нет, серию всё равно помечаем */
  }
  series[row.name] = true;
  deps.store.metaSet(FAIL_SERIES_KEY, JSON.stringify(series));
  if (!coordinator) return;
  deps
    .send(
      coordinator,
      `хук ${row.name} на ${event || "событие"} упал: ` +
        (outputTail || status),
    )
    .catch((e) =>
      deps.warn?.(
        `orchestrator hook notify ${row.name}: ${(e as Error).message}`,
      ),
    );
}
