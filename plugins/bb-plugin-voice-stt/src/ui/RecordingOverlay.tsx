/**
 * Оверлей записи живого ввода (спека voice-stt-live §3.2): единственное
 * место показа интеримов — в черновик они не пишутся. Пульс + секундомер,
 * «Отпустите/Enter — вставить», «Esc — отмена», пометка фоллбэка и
 * «копировать» для финала, который не удалось вставить (§3.3).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useComposers, useSettings } from "@get-bb/plugin-sdk/app";

import { MicGlyph } from "./MicGlyph.js";
import { voiceRecorder, type ComposerTarget, type RecorderView } from "./recorder.js";

type ComposerList = readonly (ComposerTarget & { scope?: { kind?: string } })[];

/**
 * Предпочитаем композер треда — «primary» на экране треда; иначе первый
 * on-screen (new-thread, queued-message). Нет композеров — «no-target»:
 * финал остаётся в оверлее с «копировать» (§3.1 п. 3–4).
 */
function resolveComposerTarget(list: ComposerList): ComposerTarget | null {
  return list.find((c) => c.scope?.kind === "thread") ?? list[0] ?? null;
}

/**
 * Мост useComposers → синглтон: хуки недоступны из обычных функций,
 * а резолвер цели нужен футеру и команде (§3.1 п. 2–3).
 */
function ComposersBridge() {
  const composers = useComposers();
  useEffect(() => {
    voiceRecorder.setTargetResolver(() => resolveComposerTarget(composers as ComposerList));
    return () => voiceRecorder.setTargetResolver(null);
  }, [composers]);
  return null;
}

/**
 * Плавающая кнопка живого ввода (§3.1 п. 4): оверлей смонтирован
 * постоянно → видна и без открытого композера, включая мобильный
 * клиент. Сидит на середине правого края — в стороне от композера,
 * кнопки отправки и нижних панелей. Те же жесты, что у composer-
 * кнопки; во время записи — кнопка стоп.
 */
function FloatingMic() {
  const composers = useComposers();
  const view = useSyncExternalStore(voiceRecorder.subscribe, voiceRecorder.getSnapshot);
  const active = view.phase === "recording" || view.phase === "reconnecting";
  return (
    <button
      type="button"
      className={`vsl-fab${active ? " vsl-fab--active" : ""}${view.phase === "finishing" ? " vsl-fab--busy" : ""}`}
      title={
        active
          ? "Завершить диктовку"
          : "Живой ввод: удерживайте кнопку или нажмите для диктовки"
      }
      aria-label="Живой ввод"
      aria-pressed={active}
      onPointerDown={(e) => {
        e.preventDefault();
        voiceRecorder.pressStart(
          resolveComposerTarget(composers as ComposerList),
          e.nativeEvent.pointerId,
        );
      }}
      onPointerUp={(e) => voiceRecorder.pressEnd(e.nativeEvent)}
      onPointerCancel={(e) => voiceRecorder.pressEnd(e.nativeEvent)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MicGlyph size={22} />
    </button>
  );
}

/** Питание настройки liveInput в синглтон — выключает все входы (§7). */
function SettingsBridge() {
  const { values } = useSettings();
  useEffect(() => {
    voiceRecorder.setLiveEnabled(values?.liveInput !== false);
  }, [values?.liveInput]);
  return null;
}

function elapsedLabel(view: RecorderView, now: number): string {
  const s = view.startedAt === null ? 0 : Math.max(0, Math.floor((now - view.startedAt) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const ENGINE_LABEL: Record<string, string> = {
  "gemini-live": "Gemini Live",
  codex: "Codex",
  groq: "Groq",
  silence: "тишина",
};

export function RecordingOverlay() {
  const view = useSyncExternalStore(voiceRecorder.subscribe, voiceRecorder.getSnapshot);
  const { values } = useSettings();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  const active =
    view.phase === "recording" || view.phase === "reconnecting" || view.phase === "finishing";
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  useEffect(() => setCopied(false), [view.finalText]);

  return (
    <>
      <ComposersBridge />
      <SettingsBridge />
      {values?.liveInput !== false && <FloatingMic />}
      {view.phase === "idle" ? null : (
        <div className="vsl-overlay" role="status" aria-live="polite">
          <div className={`vsl-card${view.ignorePulse % 2 === 1 ? " vsl-card--shake" : ""}`}>
            <div className="vsl-row vsl-row--head">
              {view.phase === "recording" || view.phase === "reconnecting" ? (
                <>
                  <span className="vsl-dot" aria-hidden="true" />
                  <span className="vsl-time">{elapsedLabel(view, now)}</span>
                  <span className="vsl-level" aria-hidden="true">
                    <span className="vsl-level-fill" style={{ width: `${Math.round(view.level * 100)}%` }} />
                  </span>
                </>
              ) : view.phase === "finishing" ? (
                <span className="vsl-status">Обработка…</span>
              ) : view.phase === "done" ? (
                <span className="vsl-status">
                  {view.inserted ? "Вставлено в черновик" : view.notice ?? "Готово"}
                  {view.engine !== null && (
                    <span className="vsl-engine">
                      {ENGINE_LABEL[view.engine] ?? view.engine}
                      {view.degraded ? " · фоллбэк" : ""}
                    </span>
                  )}
                </span>
              ) : (
                <span className="vsl-status vsl-status--error">{view.error ?? "ошибка"}</span>
              )}
              <button
                type="button"
                className="vsl-close"
                title={active ? "Отменить (Esc)" : "Закрыть"}
                aria-label={active ? "Отменить" : "Закрыть"}
                onClick={() => voiceRecorder.dismiss()}
              >
                ×
              </button>
            </div>

            {(view.phase === "recording" || view.phase === "reconnecting") && (
              <>
                <div className="vsl-interim">
                  {view.interim !== "" ? view.interim : "Говорите…"}
                </div>
                <div className="vsl-hint">
                  {view.notice ?? (view.holdArmed ? "Держите — или отпустите для toggle" : "Enter — вставить · Esc — отмена")}
                </div>
              </>
            )}
            {view.phase === "finishing" && view.notice !== null && (
              <div className="vsl-hint">{view.notice}</div>
            )}
            {view.phase === "done" && view.finalText !== null && (
              <>
                <div className="vsl-interim">{view.finalText}</div>
                <div className="vsl-actions">
                  <button
                    type="button"
                    className="vsl-btn"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(view.finalText ?? "")
                        .then(() => setCopied(true))
                        .catch(() => setCopied(false));
                    }}
                  >
                    {copied ? "Скопировано" : "Копировать"}
                  </button>
                </div>
              </>
            )}
            {view.phase === "error" && (
              <div className="vsl-hint">Запись отменена. Проверьте настройки плагина.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
