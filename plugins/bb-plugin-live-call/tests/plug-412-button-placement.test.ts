/**
 * PLUG-412 · спека docs/specs/live-call-button-placement.md
 *
 * Секции 2–3: два независимых тумблера места кнопки звонка — нижний футер
 * сайдбара (`callButtonFooter`, по умолчанию вкл) и левая панель навигации
 * (`callButtonNav`, по умолчанию выкл) в localStorage. Все четыре комбинации,
 * дефолты без ключей, автозвонок панели только после порога загрузки бандла,
 * экран управления («Позвонить» / «Развернуть» / «Завершить»).
 */
import React from "react";
import { renderToString } from "react-dom/server.browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import appDef from "../app.js";
import {
  AUTO_CALL_MIN_AGE_MS,
  CALL_BUTTON_FOOTER_KEY,
  CALL_BUTTON_NAV_KEY,
  CALL_PANEL_PATH,
  getCallButtonFooter,
  getCallButtonNav,
  setCallButtonFooter,
  setCallButtonNav,
  shouldAutoCallOnMount,
} from "../src/ui/button-placement.js";
import { callEngine } from "../src/ui/engine.js";
import { PlacementToggles } from "../src/ui/SettingsSection.js";

type FooterReg = { kind: string; id: string; label: string };
type NavReg = {
  id: string;
  title: string;
  icon: string;
  path: string;
  component: React.ComponentType<{ subPath: string }>;
};

/** Минимальный app-объект: нужные слоты пишут в массивы, прочие — no-op. */
function makeApp() {
  const footer: FooterReg[] = [];
  const nav: NavReg[] = [];
  const commands: Array<{ id: string; title: string }> = [];
  const app = {
    slots: {
      experimental_appOverlay: (_r: unknown) => {},
      experimental_providerIcon: (_r: unknown) => {},
      experimental_threadHeaderAction: (_r: unknown) => {},
      messageAction: (_r: unknown) => {},
      experimental_newThreadPanelAction: (_r: unknown) => {},
      settingsSection: (_r: unknown) => {},
      navPanel: vi.fn((r: NavReg) => {
        nav.push(r);
      }),
    },
    experimental_sidebarFooter: {
      register: (r: FooterReg) => {
        footer.push(r);
      },
    },
    commands: {
      register: (r: { id: string; title: string }) => {
        commands.push(r);
      },
    },
  };
  return { app: app as unknown as Parameters<typeof appDef.setup>[0], footer, nav, commands };
}

function memories() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
}

function boot(): ReturnType<typeof makeApp> {
  const m = makeApp();
  appDef.setup(m.app);
  return m;
}

describe("PLUG-412 · место кнопки звонка (§2–3 спеки live-call-button-placement)", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = memories();
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
  });

  it("дефолты без ключей: футер вкл, левая панель выкл (§2)", () => {
    expect(getCallButtonFooter()).toBe(true);
    expect(getCallButtonNav()).toBe(false);

    const { footer, nav } = boot();
    expect(footer.map((f) => f.id)).toEqual(["call"]);
    expect(nav).toEqual([]);
  });

  it("вкл+выкл — только футер, ничего не меняется (§3.1)", () => {
    setCallButtonFooter(true);
    setCallButtonNav(false);
    const { footer, nav } = boot();
    expect(footer.map((f) => f.id)).toEqual(["call"]);
    expect(footer[0]?.kind).toBe("action");
    expect(nav).toEqual([]);
  });

  it("выкл+вкл — только левая панель (§3.2)", () => {
    setCallButtonFooter(false);
    setCallButtonNav(true);
    const { footer, nav } = boot();
    expect(footer).toEqual([]);
    expect(nav).toHaveLength(1);
    expect(nav[0]).toMatchObject({ id: "call", title: "Live Call", path: CALL_PANEL_PATH });
    expect(typeof nav[0]?.icon).toBe("string");
    expect(typeof nav[0]?.component).toBe("function");
  });

  it("вкл+вкл — оба места (§3.3)", () => {
    setCallButtonFooter(true);
    setCallButtonNav(true);
    const { footer, nav } = boot();
    expect(footer.map((f) => f.id)).toEqual(["call"]);
    expect(nav.map((n) => n.id)).toEqual(["call"]);
  });

  it("выкл+выкл — ни одной кнопки, входы шортката и палитры на месте (§3.3)", () => {
    setCallButtonFooter(false);
    setCallButtonNav(false);
    const { footer, nav, commands } = boot();
    expect(footer).toEqual([]);
    expect(nav).toEqual([]);
    expect(commands.map((c) => c.id).sort()).toEqual(["call-project", "call-toggle"]);
  });

  it("невалидное значение и битый localStorage → фолбэк к дефолту (§2)", () => {
    for (const raw of ["2", "yes", "", " "]) {
      (globalThis as any).localStorage = memories();
      (globalThis as any).localStorage.setItem(CALL_BUTTON_FOOTER_KEY, raw);
      (globalThis as any).localStorage.setItem(CALL_BUTTON_NAV_KEY, raw);
      expect(getCallButtonFooter()).toBe(true);
      expect(getCallButtonNav()).toBe(false);
    }

    (globalThis as any).localStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(getCallButtonFooter()).toBe(true);
    expect(getCallButtonNav()).toBe(false);
    expect(() => setCallButtonFooter(false)).not.toThrow();
    expect(() => setCallButtonNav(true)).not.toThrow();
  });

  it("сеттеры пишут \"1\"|\"0\" в нужные ключи (§2)", () => {
    setCallButtonFooter(false);
    setCallButtonNav(true);
    expect((globalThis as any).localStorage.getItem("bb_live_call_button_footer")).toBe("0");
    expect((globalThis as any).localStorage.getItem("bb_live_call_button_nav")).toBe("1");
  });

  it("автозвонок панели только после порога загрузки бандла, ~3 с (§3.2)", () => {
    expect(AUTO_CALL_MIN_AGE_MS).toBe(3000);
    expect(shouldAutoCallOnMount(0, 0)).toBe(false);
    expect(shouldAutoCallOnMount(2999, 0)).toBe(false);
    expect(shouldAutoCallOnMount(3000, 0)).toBe(true);
    expect(shouldAutoCallOnMount(60000, 0)).toBe(true);
  });

});

describe("PLUG-412 · экран управления на странице панели (§3.2)", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = memories();
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
  });

  it("рендерит статус и кнопки «Позвонить»/«Развернуть»/«Завершить»", () => {
    const { app } = makeApp();
    setCallButtonNav(true);
    appDef.setup(app);
    const Page = (app.slots.navPanel as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].component as React.ComponentType<{ subPath: string }>;
    expect(Page).toBeTypeOf("function");

    const html = renderToString(React.createElement(Page, { subPath: "" }));
    expect(html).toContain("lc-panel__status");
    expect(html).toContain("звонка нет");
    expect(html).toContain("Позвонить");
    expect(html).toContain("Развернуть");
    expect(html).toContain("Завершить");
  });

  it("без активного звонка «Развернуть»/«Завершить» неактивны, звонок не начинается сам", () => {
    expect(callEngine.isActive()).toBe(false);
    setCallButtonNav(true);
    const { app } = makeApp();
    setCallButtonNav(true);
    appDef.setup(app);
    const Page = (app.slots.navPanel as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].component as React.ComponentType<{ subPath: string }>;
    const html = renderToString(React.createElement(Page, { subPath: "" }));
    expect(html.match(/disabled/g)?.length ?? 0).toBe(2);
    expect(callEngine.isActive()).toBe(false);
  });
});

describe("PLUG-412 · тумблеры в разделе настроек (§2–3.4)", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = memories();
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
  });

  it("два контрола: дефолт футер вкл, панель выкл; постоянная подсказка о перезагрузке", () => {
    const html = renderToString(
      React.createElement(PlacementToggles, { footer: true, nav: false, onFooter: () => {}, onNav: () => {} }),
    );
    expect(html.match(/type="checkbox"/g)?.length).toBe(2);
    expect(html).toContain("Кнопка звонка в нижнем сайдбаре");
    expect(html).toContain("Кнопка звонка в левой панели");
    expect(html).toContain("Применяется после перезагрузки страницы");
    expect(html.match(/checked=""/g)?.length).toBe(1);
  });

  it("оба выкл — видна подсказка про шорткат и палитру", () => {
    const html = renderToString(
      React.createElement(PlacementToggles, { footer: false, nav: false, onFooter: () => {}, onNav: () => {} }),
    );
    expect(html).toContain("Кнопок не будет");
    expect(html).toContain("⇧ L");
  });
});

/* PLUG-412 */
