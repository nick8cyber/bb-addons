/**
 * orchestrator §18.5 (r32, PLUG-246): хуки событий — настройка
 * `eventHooks` (`hooks` занято git-хуками), таблица `events` и
 * сопоставление события с хуками — в store.ts (та же транзакция, что и
 * переход). Здесь — разбор настройки и `notifyOnFail`: одна строка
 * координатору на серию сбоев, следующая только после успешного
 * запуска этого хука.
 */
import type { PolicyIssue } from "./policy.js";
import { T_RU, type T } from "./i18n/index.js";
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
 * `release` не ставим: хуки — дополнительная функция, ошибки ложатся
 * в журнал). §18.5 (ревью Б1–Б2): имена уникальны после обрезки
 * пробелов — дубль это ошибка разбора, а управляющие символы в имени
 * (\x00-\x1f) — тоже ошибка (PLUG-250: «\0broken» совпал бы с
 * ключом-маркером доверия) — при ЛЮБОЙ ошибке хуки не
 * запускаются вовсе (см. effectiveHooks): иначе дубль имени давал бы
 * запуск записи, которой нет в снимке доверия.
 */
export function parseEventHooks(
  raw: string | undefined,
  t: T = T_RU,
): EventHooksLoad {
  const errors: PolicyIssue[] = [];
  const hooks: EventHookSetting[] = [];
  if (raw === undefined || raw.trim() === "") return { hooks, errors };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    errors.push({
      path: "eventHooks",
      message: t("ev.notJson", { error: (e as Error).message }),
    });
    return { hooks, errors };
  }
  if (!Array.isArray(doc)) {
    errors.push({ path: "eventHooks", message: t("ev.expectArray") });
    return { hooks, errors };
  }
  doc.forEach((item, i) => {
    const path = `eventHooks[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ path, message: t("ev.hookObject") });
      return;
    }
    const h = item as Record<string, unknown>;
    if (typeof h.name !== "string" || h.name.trim() === "") {
      errors.push({ path: `${path}.name`, message: t("ev.nameString") });
      return;
    }
    const name = h.name.trim();
    // PLUG-250 (ревью PLUG-246): управляющие символы в имени запрещены —
    // «\0broken» совпал бы с ключом-маркером доверия HOOKS_BROKEN_KEY.
    if (/[\x00-\x1f]/.test(name)) {
      errors.push({ path: `${path}.name`, message: t("ev.nameControl") });
      return;
    }
    if (hooks.some((x) => x.name === name)) {
      errors.push({
        path: `${path}.name`,
        message: t("ev.nameUnique"),
      });
      return;
    }
    if (!isStrArr(h.on)) {
      errors.push({
        path: `${path}.on`,
        message: t("ev.onArray"),
      });
      return;
    }
    if (!isStrArr(h.run)) {
      errors.push({
        path: `${path}.run`,
        message: t("ev.runArray"),
      });
      return;
    }
    if (h.projects !== undefined && !isStrArr(h.projects)) {
      errors.push({
        path: `${path}.projects`,
        message: t("ev.projectsArray"),
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
        message: t("ev.timeoutInt"),
      });
      return;
    }
    if (h.notifyOnFail !== undefined && typeof h.notifyOnFail !== "boolean") {
      errors.push({
        path: `${path}.notifyOnFail`,
        message: t("ev.notifyBoolean"),
      });
      return;
    }
    hooks.push({
      name,
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

/** §18.5: при ошибке разбора `eventHooks` хуки не запускаются вовсе —
 * действующий список пуст, пока документ не исправят. */
export function effectiveHooks(load: EventHooksLoad): EventHookSetting[] {
  return load.errors.length ? [] : load.hooks;
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
  t?: T;
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
  const t = deps.t ?? T_RU;
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
      t("ev.hookFailed", {
        name: row.name,
        event: event || t("ev.eventFallback"),
        outcome: outputTail || status,
      }),
    )
    .catch((e) =>
      deps.warn?.(
        `orchestrator hook notify ${row.name}: ${(e as Error).message}`,
      ),
    );
}
