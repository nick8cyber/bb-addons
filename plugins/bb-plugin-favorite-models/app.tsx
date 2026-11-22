/**
 * bb-plugin-favorite-models — Frontend entry.
 *
 * Registers content script for DOM star injection & reordering in the model picker
 * and a settings section for managing favorites.
 */
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { initDomObserver } from "./src/dom-observer.js";
import { initBackendSync } from "./src/favorites-manager.js";
import { SettingsSection } from "./src/SettingsSection.js";

export default definePluginApp((app) => {
  // 1. Content Script: Injects star buttons and reorders models in model picker popovers
  app.contentScripts.register({
    id: "model-star-favorites",
    mount: () => {
      const cancelSync = initBackendSync();
      const cleanupObserver = initDomObserver();
      return () => {
        cancelSync();
        cleanupObserver();
      };
    },
  });

  // 2. Settings Section: View, edit, add, export/import favorites in settings
  app.slots.settingsSection({
    id: "favorite-models",
    title: "Избранные модели",
    description: "Звёздочки у моделей провайдеров и закрепление избранного вверху списка.",
    component: SettingsSection,
  });
});
