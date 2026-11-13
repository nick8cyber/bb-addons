/**
 * orchestrator §18.1 (r32, PLUG-247a): the plugin's `language` setting
 * (`en` | `ru`, default `en`) selects one string catalog —
 * `src/i18n/<lang>.ts`. Every human/agent-facing text comes from the
 * catalog by key; machine contracts (verdict JSON, error codes, field
 * and setting names, `prBody` markers, journal labels the tests grep)
 * never go through it.
 *
 * Missing key in the selected language → the `en` value plus a warning
 * in the journal (once per key).
 */
import { EN } from "./en.js";
import { RU } from "./ru.js";

export type Lang = "en" | "ru";
export type Params = Record<string, string | number | null | undefined>;

/** The catalog lookup: `t("release.dirtyWorktree", {taskKey})`. `lang`
 * is exposed for language-versioned artifacts (the pre-push hook). */
export interface T {
  (key: string, params?: Params): string;
  readonly lang: Lang;
}

const DICTS: Record<Lang, Record<string, string>> = { en: EN, ru: RU };

/**
 * §18.1: the `language` setting — `en` | `ru`, default `en`. Any other
 * (e.g. pre-key) value resolves to `en`.
 */
export function resolveLang(value: unknown): Lang {
  return value === "ru" ? "ru" : "en";
}

const MISSING_WARN =
  'orchestrator i18n: no "{lang}" string for key "{key}" — using "en"';

export function createT(lang: Lang, warn?: (msg: string) => void): T {
  const dict = DICTS[lang];
  const warned = new Set<string>();
  const fn = ((key: string, params?: Params): string => {
    let tpl = dict[key];
    if (tpl === undefined && lang !== "en") {
      if (!warned.has(key)) {
        warned.add(key);
        warn?.(
          MISSING_WARN.replace("{lang}", lang).replace("{key}", key),
        );
      }
      tpl = EN[key];
    }
    if (tpl === undefined) {
      if (!warned.has(key)) {
        warned.add(key);
        warn?.(`orchestrator i18n: unknown key "${key}"`);
      }
      return key;
    }
    return params === undefined
      ? tpl
      : tpl.replace(/\{(\w+)\}/g, (m, name: string) =>
          name in params ? String(params[name] ?? "") : m,
        );
  }) as T;
  Object.defineProperty(fn, "lang", { value: lang, enumerable: true });
  return fn;
}

/** Default for call sites whose deps carry no `t` — the historical
 * (Russian) texts, so a bare call behaves exactly as before 247a. */
export const T_RU: T = createT("ru");
