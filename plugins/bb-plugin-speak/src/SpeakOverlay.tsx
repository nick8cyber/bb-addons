/**
 * Floating overlay player banner for Gemini TTS.
 *
 * Shows:
 * 1. Generation status ("Синтез речи...") with animated spinner and cancel.
 * 2. Playback bar with Play/Pause, speed selector (0.75x - 2x), chunk progress, and close button.
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { player, type PlaybackState } from "./player.js";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export function SpeakOverlay() {
  const [playback, setPlayback] = useState<PlaybackState>(player.getState());

  useEffect(() => {
    return player.subscribe((next) => {
      setPlayback(next);
    });
  }, []);

  if (playback.stage === "idle" && !playback.speaking) {
    return null;
  }

  const isGenerating = playback.stage === "generating";
  const isPaused = playback.stage === "paused";
  const isPlaying = playback.stage === "playing";

  const nextSpeed = () => {
    const current = playback.speed;
    const idx = SPEEDS.indexOf(current);
    const next = idx >= 0 && idx < SPEEDS.length - 1 ? SPEEDS[idx + 1] : SPEEDS[0];
    player.setSpeed(next);
  };

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-auto">
      <div className="flex items-center gap-3 rounded-full border border-border bg-background/95 px-4 py-2 shadow-2xl backdrop-blur-md text-xs font-medium text-foreground transition-all duration-200 ease-out select-none">
        {/* Status icon / Spinner */}
        {isGenerating ? (
          <div className="flex items-center gap-2 text-amber-500 dark:text-amber-400">
            <svg
              className="size-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span className="font-medium text-foreground">
              Синтез речи…
              {playback.chunkCount > 1
                ? ` (чанк ${playback.chunkIndex + 1}/${playback.chunkCount})`
                : ""}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {/* Play/Pause Button */}
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              onClick={() => {
                if (isPaused) {
                  player.resume();
                } else if (isPlaying) {
                  player.pause();
                }
              }}
              title={isPaused ? "Продолжить" : "Пауза"}
            >
              {isPaused ? (
                <svg className="size-3.5 fill-current ml-0.5" viewBox="0 0 24 24">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              ) : (
                <svg className="size-3.5 fill-current" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              )}
            </button>

            {/* Playback info */}
            <div className="flex items-center gap-1.5 px-1">
              <span className="text-muted-foreground">
                {isPaused ? "Пауза" : "Воспроизведение"}
              </span>
              <span className="font-semibold text-foreground">
                {playback.voice || "Gemini"}
              </span>
              {playback.chunkCount > 1 && (
                <span className="text-[11px] text-muted-foreground">
                  • {playback.chunkIndex + 1}/{playback.chunkCount}
                </span>
              )}
            </div>

            {/* Speed toggle */}
            <button
              type="button"
              className="rounded-md border border-border/80 bg-muted/60 px-2 py-0.5 text-[11px] font-mono hover:bg-muted transition-colors text-foreground"
              onClick={nextSpeed}
              title="Изменить скорость воспроизведения"
            >
              {playback.speed}×
            </button>
          </div>
        )}

        {/* Separator */}
        <div className="h-4 w-px bg-border/60" />

        {/* Stop / Close Button */}
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          onClick={() => player.stop()}
          title="Закрыть плеер"
        >
          <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** Mounts the floating player overlay once onto document.body */
export function mountSpeakOverlay(): () => void {
  const host = document.createElement("div");
  host.id = "bb-speak-overlay-host";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<SpeakOverlay />);
  return () => {
    root.unmount();
    host.remove();
  };
}
