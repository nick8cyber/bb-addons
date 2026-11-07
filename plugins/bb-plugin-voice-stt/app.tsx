/**
 * Фронтенд voice-stt — живой голосовой ввод (спека voice-stt-live §3).
 *
 * Точки входа (все ведут в один recording singleton):
 * - плавающая кнопка (FAB) в appOverlay — основной вход, видна всегда,
 *   перетаскивается, позиция запоминается на устройстве (§3.1 п. 4);
 * - composer-команда «Voice STT Live: диктовка» + Mod+Shift/V — получает
 *   bound composer в run({composer});
 * - experimental_sidebarFooter «Диктовка» — цель резолвится через
 *   useComposers() в оверлее.
 *
 * В строке ввода — только нативный микрофон bb (слово владельца 07.11):
 * своей composer-кнопки нет, нативную не трогаем.
 */
import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { MicSettings } from "./src/ui/MicSettings.js";
import { RecordingOverlay } from "./src/ui/RecordingOverlay.js";
import { voiceRecorder } from "./src/ui/recorder.js";

const MIC_ICON = "voice-stt/mic";

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "voice-stt-live", component: RecordingOverlay });

  // Выбор микрофона на этом устройстве (§7.1): страница плагина (на телефоне — та же).
  app.slots.settingsSection({
    id: "microphone",
    title: "Микрофон",
    description: "Какой микрофон использует живой ввод на этом устройстве",
    component: MicSettings,
  });


  // Composer-команда: run({composer}) получает bound композер (§3.1 п. 2).
  app.composer.experimental_registerCommand({
    id: "live-dictation",
    title: "Voice STT Live: диктовка",
    defaultShortcut: { key: "v", mod: true, shift: true },
    run: ({ composer }) => {
      voiceRecorder.toggle(composer);
    },
  });

  // Запасной вход (§3.1 п. 3): целевой композер резолвится в оверлее.
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "dictation",
    label: "Диктовка",
    icon: MIC_ICON,
    onActivate: () => {
      voiceRecorder.toggle();
    },
  });
});
