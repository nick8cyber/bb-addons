/**
 * «Где показывать кнопку звонка» (§2, §3.2 спеки live-call-button-placement).
 *
 * Два независимых тумблера — футер сайдбара и левая панель — в localStorage.
 * Механизм как у `getHideClaude()/setHideClaude()` в usage-pro: синхронные
 * getter/setter. `useSettings()` синхронно при старте `definePluginApp` не
 * вызвать, а регистрации слотов (footer-action, navPanel) нужны ровно в этот
 * момент — поэтому чтение localStorage прямое.
 *
 * Невалидное значение или исключение доступа к localStorage → дефолт
 * (footer вкл — текущий вид, nav выкл — новая поверхность по умолчанию молчит).
 */
import { useCallback, useEffect, useState } from "react";

export const CALL_BUTTON_FOOTER_KEY = "bb_live_call_button_footer";
export const CALL_BUTTON_NAV_KEY = "bb_live_call_button_nav";

/** URL-сегмент страницы панели: /plugins/live-call/call (§3.2). */
export const CALL_PANEL_PATH = "call";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? "1" : "0");
  } catch {
    // Нет доступа к localStorage — настройка не сохранится, но раздел не падает.
  }
}

export function getCallButtonFooter(): boolean {
  return readFlag(CALL_BUTTON_FOOTER_KEY, true);
}

export function setCallButtonFooter(value: boolean): void {
  writeFlag(CALL_BUTTON_FOOTER_KEY, value);
}

export function getCallButtonNav(): boolean {
  return readFlag(CALL_BUTTON_NAV_KEY, false);
}

export function setCallButtonNav(value: boolean): void {
  writeFlag(CALL_BUTTON_NAV_KEY, value);
}

export type CallButtonPlacement = { footer: boolean; nav: boolean };

/** Текущее положение обоих тумблеров разом — как состояние хука. */
export function readCallButtonPlacement(): CallButtonPlacement {
  return { footer: getCallButtonFooter(), nav: getCallButtonNav() };
}

export const sameCallButtonPlacement = (a: CallButtonPlacement, b: CallButtonPlacement): boolean =>
  a.footer === b.footer && a.nav === b.nav;

/**
 * §2: хук по образцу `useHideClaude()` в usage-pro — синхронные setter с записью
 * в localStorage и подпиской на `storage`, чтобы смена в другой вкладке этого
 * браузера сразу отражалась в контролах (событие `storage` приходит только
 * другим вкладкам, поэтому локальная запись обновляет state сама).
 */
export function useCallButtonPlacement(): {
  placement: CallButtonPlacement;
  setFooter: (value: boolean) => void;
  setNav: (value: boolean) => void;
} {
  const [placement, setPlacement] = useState<CallButtonPlacement>(readCallButtonPlacement);

  const setFooter = useCallback((value: boolean) => {
    setCallButtonFooter(value);
    setPlacement((prev) => (prev.footer === value ? prev : { ...prev, footer: value }));
  }, []);

  const setNav = useCallback((value: boolean) => {
    setCallButtonNav(value);
    setPlacement((prev) => (prev.nav === value ? prev : { ...prev, nav: value }));
  }, []);

  useEffect(() => {
    if (typeof globalThis.addEventListener !== "function") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== CALL_BUTTON_FOOTER_KEY && event.key !== CALL_BUTTON_NAV_KEY) return;
      setPlacement((prev) => {
        const next = readCallButtonPlacement();
        return sameCallButtonPlacement(prev, next) ? prev : next;
      });
    };
    globalThis.addEventListener("storage", onStorage as EventListener);
    return () => {
      globalThis.removeEventListener("storage", onStorage as EventListener);
    };
  }, []);

  return { placement, setFooter, setNav };
}

/**
 * §3.2: автозвонок страницы панели — только при клиентском переходе, не при
 * свежей загрузке документа (F5 / восстановление вкладки / перезагрузка из §3.4).
 * `bundleLoadedAt` — момент первой интерпретации app-бандла, живёт в модуле и
 * переживает клиентские переходы, но не переживает загрузку документа заново.
 */
export const APP_BUNDLE_LOADED_AT: number = Date.now();

/** Порог свежести загрузки, мс: раньше — документ только что открылся (§3.2, ~3 с). */
export const AUTO_CALL_MIN_AGE_MS = 3000;

export function shouldAutoCallOnMount(now: number = Date.now(), loadedAt: number = APP_BUNDLE_LOADED_AT): boolean {
  return now - loadedAt >= AUTO_CALL_MIN_AGE_MS;
}
