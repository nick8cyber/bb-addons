/**
 * Фронтенд live-call. Вход в звонок — штатными поверхностями BB, без своей
 * плавающей кнопки: иконка в футере сайдбара, кнопка в шапке треда, команды
 * палитры с горячими клавишами. Док рисует experimental_appOverlay — так у него
 * есть контекст BB (навигация к тредам, тема).
 */
import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { CallOverlay } from "./src/ui/CallOverlay.js";
import { SettingsSection } from "./src/ui/SettingsSection.js";
import { callEngine } from "./src/ui/engine.js";

const PHONE_ICON = "live-call/phone";

/** Нет звонка — позвонить; звонок идёт — развернуть док. */
const callOrFocus = () => (callEngine.isActive() ? callEngine.requestExpand() : callEngine.start());

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "live-call", component: CallOverlay });

  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "call",
    label: "Позвонить координатору",
    icon: PHONE_ICON,
    onActivate: callOrFocus,
  });

  app.slots.experimental_threadAction({
    id: "call",
    title: "Позвонить координатору",
    icon: PHONE_ICON,
    group: "live-call",
    placement: "header",
    item: () => ({ label: "Позвонить", icon: PHONE_ICON, run: callOrFocus }),
  });

  app.commands.register({
    id: "call-toggle",
    title: "Live Call: позвонить / завершить звонок",
    defaultShortcut: { key: "l", mod: true, shift: true },
    run: () => (callEngine.isActive() ? callEngine.end() : callEngine.start()),
  });

  app.commands.register({
    id: "call-mode",
    title: "Live Call: переключить режим (Обычный ↔ Extended)",
    defaultShortcut: { key: "k", mod: true, shift: true },
    isAvailable: () => callEngine.getSnapshot().phase === "live",
    run: () => callEngine.toggleMode(),
  });

  app.slots.settingsSection({
    id: "live-call",
    title: "Live Call",
    description: "Голосовой звонок с координатором BB через Gemini Live API. Ключи, голос и лимиты — в этом разделе.",
    component: SettingsSection,
  });
});
