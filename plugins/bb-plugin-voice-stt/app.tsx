/**
 * Фронтенд voice-stt — живой голосовой ввод (спека voice-stt-live §3).
 *
 * Точки входа (все ведут в один recording singleton):
 * - composer.actions: кнопка микрофона (все scope'ы; в compact-режиме хост
 *   actions не рисует — покрыто командой и футером);
 * - composer-команда «Voice STT Live: диктовка» + Mod+Shift/V — получает
 *   bound composer в run({composer}), привязка бесплатная;
 * - experimental_sidebarFooter «Диктовка» — цель резолвится через
 *   useComposers() в оверлее.
 *
 * Нативную кнопку не скрываем (§3.1): две кнопки сосуществуют, наша — с
 * другой иконкой и подсказкой «Живой ввод».
 */
import "./app.css";
import { definePluginApp, useComposer, useSettings } from "@get-bb/plugin-sdk/app";
import { useSyncExternalStore } from "react";

import { RecordingOverlay } from "./src/ui/RecordingOverlay.js";
import { voiceRecorder } from "./src/ui/recorder.js";

const MIC_ICON = "voice-stt/mic";

function MicGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="2" />
      <path
        d="M5 10a7 7 0 0 0 14 0M12 19v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Кнопка в composer.actions (§3.1 п. 1, §3.3): pointerdown → старт
 * немедленно; hold >400 мс → end на отпускании, тап → toggle.
 */
function LiveMicAction() {
  const composer = useComposer();
  const { values } = useSettings();
  const view = useSyncExternalStore(voiceRecorder.subscribe, voiceRecorder.getSnapshot);
  if (values?.liveInput === false) return null;
  const active = view.phase === "recording" || view.phase === "reconnecting";
  return (
    <button
      type="button"
      className={`vsl-mic${active ? " vsl-mic--active" : ""}`}
      title={
        active
          ? "Идёт диктовка — нажмите, чтобы завершить"
          : "Живой ввод: удерживайте кнопку или нажмите для диктовки"
      }
      aria-label="Живой ввод"
      aria-pressed={active}
      onPointerDown={(e) => {
        e.preventDefault();
        voiceRecorder.pressStart(composer);
      }}
      onPointerUp={(e) => voiceRecorder.pressEnd(e.nativeEvent)}
      onPointerCancel={(e) => voiceRecorder.pressEnd(e.nativeEvent)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MicGlyph />
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "voice-stt-live", component: RecordingOverlay });

  app.composer.customize({
    id: "voice-stt-live",
    actions: [{ id: "live-mic", component: LiveMicAction }],
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
