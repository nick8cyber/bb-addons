/**
 * Общее состояние фронтенда плагина.
 *
 * Контент-скрипт и React-слоты живут в одном бандле и в одном окне, поэтому
 * переключатель в настройках и кнопка в подвале боковой панели управляют одним и
 * тем же переводчиком через этот модуль — без похода на сервер.
 */

import { DICTIONARY, DICTIONARY_SIZE } from "./dictionary.js";
import { Translator, type TranslatorStats } from "./translator.js";

const ENABLED_KEY = "bb-plugin-ru:enabled";
const RPC_BASE = "/api/v1/plugins/ru/rpc";

let translator: Translator | null = null;
let collecting = false;
const listeners = new Set<() => void>();

export { DICTIONARY_SIZE };

export function isEnabled(): boolean {
  try {
    // По умолчанию плагин включён: его для этого и ставят.
    return window.localStorage.getItem(ENABLED_KEY) !== "off";
  } catch {
    return true;
  }
}

function persist(enabled: boolean): void {
  try {
    window.localStorage.setItem(ENABLED_KEY, enabled ? "on" : "off");
  } catch {
    // Приватный режим без localStorage — переключатель просто не запомнится.
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Ответ сервера про сбор приходит уже после того, как раздел настроек
 * отрисовался, поэтому смену состояния надо объявить — иначе страница до конца
 * жизни окна показывает «сбор выключен».
 */
function applyCollecting(next: boolean): void {
  const changed = collecting !== next;
  collecting = next;
  translator?.setCollectMissing(next);
  if (changed) notify();
}

async function callRpc<T>(method: string, input: unknown): Promise<T | null> {
  try {
    const response = await fetch(`${RPC_BASE}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json()) as
      | { ok: true; result: T }
      | { ok: false; error: unknown };
    return payload.ok ? payload.result : null;
  } catch {
    return null;
  }
}

/** Создаёт переводчик и, если плагин включён, сразу применяет перевод. */
export function mount(): () => void {
  translator = new Translator({
    dictionary: DICTIONARY,
    collectMissing: collecting,
    onMissing: (keys) => {
      void callRpc<{ accepted: number; collecting: boolean }>("reportMissing", {
        strings: [...keys].slice(0, 200),
      }).then((result) => {
        if (result === null) return;
        // Сервер — источник истины про сбор: выключили в настройках — молчим.
        applyCollecting(result.collecting);
      });
    },
  });

  void callRpc<{ collecting: boolean; missingCount: number }>(
    "status",
    null,
  ).then((status) => {
    if (status !== null) applyCollecting(status.collecting);
  });

  if (isEnabled()) translator.start();
  notify();

  return () => {
    translator?.stop();
    translator = null;
    notify();
  };
}

/** Включает или выключает перевод немедленно, без перезагрузки окна. */
export function setEnabled(enabled: boolean): void {
  persist(enabled);
  if (translator === null) {
    notify();
    return;
  }
  if (enabled) translator.start();
  else translator.stop();
  notify();
}

export function toggle(): boolean {
  const next = !isEnabled();
  setEnabled(next);
  return next;
}

export function stats(): TranslatorStats | null {
  return translator?.stats() ?? null;
}

export function isCollecting(): boolean {
  return collecting;
}

export interface MissingRow {
  text: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export function fetchMissing(limit: number): Promise<MissingRow[]> {
  return callRpc<{ rows: MissingRow[] }>("listMissing", { limit }).then(
    (result) => result?.rows ?? [],
  );
}

export function clearMissing(): Promise<number> {
  return callRpc<{ removed: number }>("clearMissing", null).then(
    (result) => result?.removed ?? 0,
  );
}
