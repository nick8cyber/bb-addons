// bb-plugin-privacy-blur — фронтенд.
//
// Кнопка в подвале сайдбара (и Alt+Shift+P) включает «приватный режим»: почты,
// id, пути, URL, домены, IP, токены, имена проектов/хостов и свои слова
// размываются прямо в интерфейсе. Состояние хранится в localStorage вкладки.
import { useEffect, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_useServers,
  experimental_useSidebarThreads,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { IGNORE_ATTR, PrivacyBlurEngine } from "./lib/engine";

let engine: PrivacyBlurEngine | null = null;
// Подписчики живут отдельно от движка: оверлей может смонтироваться раньше
// content script или пережить его перезапуск.
const stateListeners = new Set<() => void>();
function notifyState(): void {
  for (const listener of stateListeners) listener();
}

function subscribe(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}
function getEnabled(): boolean {
  return engine?.isEnabled() ?? false;
}

export function isToggleShortcut(event: KeyboardEvent): boolean {
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyP";
}

/** Части адреса страницы, по которым узнаётся инстанс: sursun.getbb.app → sursun. */
export function hostLabels(hostname: string): string[] {
  if (!hostname || hostname === "localhost" || /^[\d.:[\]]+$/.test(hostname)) return [];
  const labels = hostname.split(".");
  return [hostname, ...(labels.length > 2 ? [labels[0]!] : [])];
}

/** Слова, известные только фронтенду: заголовки тредов, серверы, адрес страницы. */
function useClientTerms(enabled: boolean): void {
  const sidebar = experimental_useSidebarThreads();
  const servers = experimental_useServers();
  useEffect(() => {
    if (!enabled || !engine) return;
    const terms: string[] = [...hostLabels(window.location.hostname)];
    for (const server of servers?.servers ?? []) {
      terms.push(server.name);
      try {
        terms.push(...hostLabels(new URL(server.origin).hostname));
      } catch {
        // Кривой origin — пропускаем.
      }
    }
    for (const project of sidebar.projects) if (!project.isPersonal) terms.push(project.name);
    for (const host of sidebar.experimental_hosts ?? []) terms.push(host.name);
    const titles: string[] = [];
    for (const thread of sidebar.threads) {
      titles.push(thread.displayTitle);
      if (thread.title) titles.push(thread.title);
    }
    engine.setClientTerms(terms, titles);
  }, [enabled, sidebar.threads, sidebar.projects, sidebar.experimental_hosts, servers]);
}

/** Плашка-индикатор режима: тянет настройки с сервера и даёт выключить одним кликом. */
function PrivacyOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const enabled = useSyncExternalStore(subscribe, getEnabled, getEnabled);
  useClientTerms(enabled);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    rpc.call("privacy_options", null).then(
      (options) => {
        if (!cancelled) engine?.setOptions(options);
      },
      () => {
        // Сервер недоступен — работают встроенные шаблоны.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, rpc]);

  if (!enabled) return null;
  return (
    <button
      type="button"
      {...{ [IGNORE_ATTR]: "" }}
      onClick={() => engine?.setEnabled(false)}
      title="Приватный режим включён — нажмите, чтобы показать данные (Alt+Shift+P)"
      className="fixed bottom-3 right-3 z-[2147483000] flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
    >
      <span aria-hidden="true">●</span>
      Данные скрыты
    </button>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "privacy-blur",
    mount({ signal }) {
      const instance = new PrivacyBlurEngine();
      engine = instance;
      instance.subscribe(notifyState);
      instance.restore();
      notifyState();
      const onKeyDown = (event: KeyboardEvent) => {
        if (!isToggleShortcut(event)) return;
        event.preventDefault();
        instance.toggle();
      };
      // Синхронизация между вкладками одного браузера.
      const onStorage = (event: StorageEvent) => {
        if (event.key === "bb-privacy-blur:enabled") {
          instance.setEnabled(event.newValue === "1", { persist: false });
        }
      };
      window.addEventListener("keydown", onKeyDown, { signal, capture: true });
      window.addEventListener("storage", onStorage, { signal });
      return () => {
        window.removeEventListener("keydown", onKeyDown, { capture: true });
        window.removeEventListener("storage", onStorage);
        instance.dispose();
        if (engine === instance) engine = null;
        notifyState();
      };
    },
  });

  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "toggle",
    label: "Скрыть/показать чувствительные данные (Alt+Shift+P)",
    icon: "EyeOff",
    onActivate: () => engine?.toggle(),
  });

  app.slots.experimental_appOverlay({
    id: "indicator",
    component: PrivacyOverlay,
  });
});
