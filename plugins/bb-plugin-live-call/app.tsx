/**
 * Фронтенд live-call: плавающая кнопка 📞 и оверлей звонка (React, движок звонка
 * в src/ui/engine.ts), раздел настроек со статусом и пробой Extended (спека §6).
 */
import "./app.css";
import { createRoot } from "react-dom/client";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { CallOverlay } from "./src/ui/CallOverlay.js";
import { SettingsSection } from "./src/ui/SettingsSection.js";
import { callEngine } from "./src/ui/engine.js";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "live-call-overlay",
    mount: () => {
      // Кнопка 📞 + React-оверлей (док/пилюля/мобильный экран; idle — ничего не рисует).
      const btn = document.createElement("button");
      btn.id = "bb-live-call-button";
      btn.title = "Позвонить координатору (живой голос)";
      btn.textContent = "📞";
      btn.style.cssText = [
        "position: fixed", "right: 24px", "bottom: 24px", "z-index: 999998",
        "width: 44px", "height: 44px", "border-radius: 50%",
        "border: 1px solid rgba(255,255,255,.15)",
        "background: var(--color-primary, #4f6ef7)", "color: #fff",
        "font-size: 20px", "cursor: pointer",
        "box-shadow: 0 6px 20px rgba(0,0,0,.35)", "pointer-events: auto",
      ].join(";");
      btn.addEventListener("click", () => callEngine.start());
      document.body.append(btn);

      const host = document.createElement("div");
      host.id = "bb-live-call-host";
      document.body.append(host);
      const root = createRoot(host);
      root.render(<CallOverlay />);
      return () => {
        root.unmount();
        callEngine.dismiss();
        host.remove();
        btn.remove();
      };
    },
  });

  app.slots.settingsSection({
    id: "live-call",
    title: "Live Call",
    description: "Голосовой звонок с координатором BB через Gemini Live API. Ключи, голос и лимиты — в этом разделе.",
    component: SettingsSection,
  });
});
