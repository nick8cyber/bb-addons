/**
 * Direct DOM floating player overlay for bb-plugin-speak.
 *
 * Mounts directly onto document.body with z-index: 999999.
 * Subscribes to player state and updates synchronously.
 */

import { player, type PlaybackState } from "./player.js";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export function mountSpeakOverlay(): () => void {
  if (typeof document === "undefined") return () => {};

  const existing = document.getElementById("bb-speak-floating-player");
  if (existing) existing.remove();

  const container = document.createElement("div");
  container.id = "bb-speak-floating-player";
  container.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999999;
    display: none;
    pointer-events: auto;
    font-family: system-ui, -apple-system, sans-serif;
  `;

  const bar = document.createElement("div");
  bar.style.cssText = `
    display: flex;
    align-items: center;
    gap: 10px;
    background: #18181b;
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.15);
    padding: 8px 14px;
    border-radius: 9999px;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    font-size: 12px;
    font-weight: 500;
    user-select: none;
    touch-action: manipulation;
    white-space: nowrap;
  `;

  container.appendChild(bar);
  document.body.appendChild(container);

  function render(state: PlaybackState) {
    if (state.stage === "idle" && !state.speaking) {
      container.style.display = "none";
      bar.innerHTML = "";
      return;
    }

    container.style.display = "block";

    if (state.stage === "generating") {
      bar.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; color: #fbbf24;">
          <svg style="width: 14px; height: 14px; animation: bb-speak-spin 1s linear infinite;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-opacity="0.25"></circle>
            <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" fill="currentColor"></path>
          </svg>
          <span style="color: #ffffff;">Генерация речи… ${state.chunkCount > 1 ? `(${state.chunkIndex + 1}/${state.chunkCount})` : ""}</span>
        </div>
        <div style="width: 1px; height: 14px; background: rgba(255, 255, 255, 0.2);"></div>
        <button id="bb-speak-btn-close" style="background: none; border: none; color: #a1a1aa; cursor: pointer; padding: 2px 4px; display: flex; align-items: center; border-radius: 4px;" title="Отмена">
          <svg style="width: 14px; height: 14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;
    } else {
      const isPaused = state.stage === "paused";
      bar.innerHTML = `
        <button id="bb-speak-btn-playpause" style="background: #2563eb; border: none; color: #ffffff; width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;" title="${isPaused ? "Продолжить" : "Пауза"}">
          ${isPaused
            ? `<svg style="width: 12px; height: 12px; fill: currentColor; margin-left: 2px;" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`
            : `<svg style="width: 12px; height: 12px; fill: currentColor;" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`
          }
        </button>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="color: #a1a1aa;">${isPaused ? "Пауза" : "Воспроизведение"}</span>
          <span style="color: #ffffff; font-weight: 600;">${state.voice || "Gemini"}</span>
          ${state.chunkCount > 1 ? `<span style="color: #71717a; font-size: 11px;">• ${state.chunkIndex + 1}/${state.chunkCount}</span>` : ""}
        </div>
        <button id="bb-speak-btn-speed" style="background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.15); color: #ffffff; border-radius: 4px; padding: 2px 6px; font-size: 11px; font-family: monospace; cursor: pointer;" title="Скорость">
          ${state.speed}×
        </button>
        <div style="width: 1px; height: 14px; background: rgba(255, 255, 255, 0.2);"></div>
        <button id="bb-speak-btn-close" style="background: none; border: none; color: #a1a1aa; cursor: pointer; padding: 2px 4px; display: flex; align-items: center; border-radius: 4px;" title="Закрыть">
          <svg style="width: 14px; height: 14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;
    }

    const btnPlayPause = bar.querySelector("#bb-speak-btn-playpause");
    btnPlayPause?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.stage === "paused") {
        player.resume();
      } else if (state.stage === "playing") {
        player.pause();
      }
    });

    const btnSpeed = bar.querySelector("#bb-speak-btn-speed");
    btnSpeed?.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = SPEEDS.indexOf(state.speed);
      const next = idx >= 0 && idx < SPEEDS.length - 1 ? SPEEDS[idx + 1] : SPEEDS[0];
      player.setSpeed(next);
    });

    const btnClose = bar.querySelector("#bb-speak-btn-close");
    btnClose?.addEventListener("click", (e) => {
      e.stopPropagation();
      player.stop();
    });
  }

  // Inject keyframe animation if not present
  if (!document.getElementById("bb-speak-keyframes")) {
    const style = document.createElement("style");
    style.id = "bb-speak-keyframes";
    style.textContent = `
      @keyframes bb-speak-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  const unsubscribe = player.subscribe(render);
  render(player.getState());

  return () => {
    unsubscribe();
    container.remove();
  };
}
