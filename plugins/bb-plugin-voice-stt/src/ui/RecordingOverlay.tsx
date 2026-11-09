/**
 * Оверлей записи живого ввода (спека voice-stt-live §3.2): единственное
 * место показа интеримов — в черновик они не пишутся. Пульс + секундомер,
 * «Отпустите/Enter — вставить», «Esc — отмена», пометка фоллбэка и
 * «копировать» для финала, который не удалось вставить (§3.3).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { useComposers, useSettings } from "@get-bb/plugin-sdk/app";

import { MicGlyph } from "./MicGlyph.js";
import {
  FAB_MARGIN,
  FAB_SIZE,
  loadFabRatio,
  pxToRatio,
  ratioToPx,
  saveFabRatio,
  type FabRatio,
} from "./fabPosition.js";
import { DEFAULT_WARM_MS, voiceRecorder, type ComposerTarget, type RecorderView } from "./recorder.js";

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

/** Сдвиг пальца/курсора, после которого жест — перенос кнопки, а не тап. */
const DRAG_PX = 10;
/**
 * Сдвиг во время push-to-talk, после которого это перенос, а не дрожь
 * пальца при разговоре: запись отменяется, кнопка едет (палец постоял
 * 300 мс и только потом поехал — частый старт переноса на iPhone).
 */
const HOLD_DRAG_PX = 24;
/** Удержание без сдвига дольше этого — push-to-talk. */
const HOLD_START_MS = 300;
/**
 * Предзахват на касании — не сразу, а через 120 мс без сдвига: перенос
 * начинается раньше, и на переносе микрофон не трогается вовсе (старт
 * getUserMedia на касании подвешивал отрисовку на iOS, 0.1.8; плюс
 * оранжевый индикатор на каждом переносе — ревью 0.1.16).
 */
const PRIME_DELAY_MS = 120;

interface FabGesture {
  pointerId: number;
  x0: number;
  y0: number;
  /** Смещение точки хвата от левого-верхнего угла кнопки. */
  dx: number;
  dy: number;
  /**
   * pending — нажали в покое, ещё не ясно: тап / удержание / перенос;
   * hold — удержание распознано, идёт push-to-talk;
   * start — мышь/трекпад: запись стартовала сразу на нажатии (тап/удержание
   *   решает рекордер по 400 мс, перенос отменяет запись);
   * stop — нажали во время записи (стоп на отпускании);
   * drag — переносим кнопку.
   */
  mode: "pending" | "start" | "hold" | "stop" | "drag";
  timer: ReturnType<typeof setTimeout> | null;
  primeTimer: ReturnType<typeof setTimeout> | null;
  last: { left: number; top: number } | null;
}

/**
 * Видимая часть окна (§3.1 п. 1, §3.2). На iOS клавиатура не уменьшает
 * окно — она перекрывает его низ, и сжимается только visualViewport.
 * Элементы с position:fixed, посчитанные от окна, уходят под клавиатуру,
 * поэтому FAB и плашка считают позицию от visualViewport.
 * x/y — смещение видимой области в координатах окна (как у fixed);
 * keyboard — сколько окна снизу закрыто (клавиатура, панели).
 */
interface VisibleArea {
  x: number;
  y: number;
  w: number;
  h: number;
  keyboard: number;
}

function readVisibleArea(): VisibleArea {
  const vv = window.visualViewport;
  const layoutH = document.documentElement.clientHeight || window.innerHeight;
  if (!vv) return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, keyboard: 0 };
  return {
    x: vv.offsetLeft,
    y: vv.offsetTop,
    w: vv.width,
    h: vv.height,
    keyboard: Math.max(0, Math.round(layoutH - (vv.offsetTop + vv.height))),
  };
}

/**
 * Общее хранилище видимой области на уровне модуля: слушатели живут
 * дольше компонентов. Оверлей перемонтируется, когда открывается поле
 * ввода, и компонентный слушатель пропускал resize от клавиатуры —
 * кнопка оставалась под ней до следующей перерисовки.
 */
let areaSnap: VisibleArea | null = null;
const areaListeners = new Set<() => void>();
let areaHooked = false;
let settleUntil = 0;

function sameArea(a: VisibleArea, b: VisibleArea): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.keyboard === b.keyboard;
}

function refreshArea(): void {
  const next = readVisibleArea();
  if (areaSnap !== null && sameArea(areaSnap, next)) return;
  areaSnap = next;
  for (const fn of areaListeners) fn();
}

/** Клавиатура выезжает анимацией ~0.3–0.5 с — перечитываем область кадр за кадром. */
function settleArea(): void {
  const start = settleUntil === 0 || performance.now() > settleUntil;
  settleUntil = performance.now() + 700;
  if (!start) return;
  const tick = (): void => {
    refreshArea();
    if (performance.now() < settleUntil) requestAnimationFrame(tick);
    else settleUntil = 0;
  };
  requestAnimationFrame(tick);
}

function hookArea(): void {
  if (areaHooked) return;
  areaHooked = true;
  const vv = window.visualViewport;
  window.addEventListener("resize", refreshArea);
  vv?.addEventListener("resize", refreshArea);
  vv?.addEventListener("scroll", refreshArea);
  // Фокус поля ввода = клавиатура появится/уйдёт.
  window.addEventListener("focusin", settleArea, true);
  window.addEventListener("focusout", settleArea, true);
  window.addEventListener("orientationchange", settleArea);
}

function subscribeArea(fn: () => void): () => void {
  hookArea();
  areaListeners.add(fn);
  refreshArea(); // догоняем изменения, случившиеся до подписки
  return () => areaListeners.delete(fn);
}

function getAreaSnapshot(): VisibleArea {
  if (areaSnap === null) areaSnap = readVisibleArea();
  return areaSnap;
}

function useVisibleArea(): VisibleArea {
  return useSyncExternalStore(subscribeArea, getAreaSnapshot);
}

/** Позиция по умолчанию — середина правого края видимой области. */
const DEFAULT_RATIO: FabRatio = { xr: 1, yr: 0.5 };

/**
 * Плавающая кнопка живого ввода (§3.1 п. 1) — основной вход, видна
 * всегда. Касание — кнопка сразу подсвечивается, но микрофон и сокет
 * НЕ стартуют: тап (отпустили без сдвига) — старт toggle-записи;
 * удержание 300 мс — push-to-talk; сдвиг > 10 px — перенос кнопки,
 * кнопка едет за пальцем прямой записью стиля (без перерисовок React).
 * Во время записи: тап — стоп, сдвиг — перенос без остановки. Сдвиг
 * > 24 px в push-to-talk — отмена записи и перенос.
 */
function FloatingMic() {
  const composers = useComposers();
  const view = useSyncExternalStore(voiceRecorder.subscribe, voiceRecorder.getSnapshot);
  const area = useVisibleArea();
  const [ratio, setRatio] = useState<FabRatio | null>(() => loadFabRatio());
  const [pressed, setPressed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<FabGesture | null>(null);
  const active = view.phase === "recording" || view.phase === "reconnecting";

  const local = ratioToPx(ratio ?? DEFAULT_RATIO, area.w, area.h);
  const style = { left: area.x + local.left, top: area.y + local.top, right: "auto" };
  const target = (): ComposerTarget | null => resolveComposerTarget(composers as ComposerList);

  const clearTimer = (g: FabGesture): void => {
    if (g.timer !== null) {
      clearTimeout(g.timer);
      g.timer = null;
    }
    if (g.primeTimer !== null) {
      clearTimeout(g.primeTimer);
      g.primeTimer = null;
    }
  };

  const finishGesture = (e: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean): void => {
    const g = gesture.current;
    if (g === null || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    clearTimer(g);
    setPressed(false);
    if (g.mode === "drag") {
      setDragging(false);
      if (g.last !== null) {
        const a = readVisibleArea();
        const r = pxToRatio(g.last.left - a.x, g.last.top - a.y, a.w, a.h);
        setRatio(r);
        saveFabRatio(r);
      }
      return;
    }
    if (g.mode === "pending") {
      if (cancelled) voiceRecorder.unprime();
      else voiceRecorder.toggle(target()); // тап — старт, конец — следующим тапом
      return;
    }
    if (g.mode === "stop") {
      if (!cancelled) voiceRecorder.stop();
      return;
    }
    // hold/start: отпустили — рекордер решает (hold → конец, короткий клик → toggle).
    voiceRecorder.pressEnd(e.nativeEvent);
  };

  return (
    <button
      type="button"
      className={`vsl-fab${active ? " vsl-fab--active" : ""}${pressed && !active ? " vsl-fab--pressed" : ""}${view.phase === "finishing" ? " vsl-fab--busy" : ""}${dragging ? " vsl-fab--drag" : ""}`}
      style={style}
      title={
        active
          ? "Завершить диктовку (перетащите, чтобы сдвинуть)"
          : "Живой ввод: нажмите или удерживайте; перетащите, чтобы сдвинуть"
      }
      aria-label="Живой ввод"
      aria-pressed={active}
      onPointerDown={(e) => {
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // без захвата перенос работает по событиям, приходящим на кнопку
        }
        const rect = e.currentTarget.getBoundingClientRect();
        const g: FabGesture = {
          pointerId: e.pointerId,
          x0: e.clientX,
          y0: e.clientY,
          dx: e.clientX - rect.left,
          dy: e.clientY - rect.top,
          mode: active ? "stop" : "pending",
          timer: null,
          primeTimer: null,
          last: null,
        };
        gesture.current = g;
        if (!active && e.pointerType !== "touch") {
          // Мышь/трекпад: микрофон стартует сразу — задержка ради плавного
          // переноса нужна только iOS (там старт аудио вешал отрисовку).
          g.mode = "start";
          voiceRecorder.pressStart(target(), e.nativeEvent.pointerId);
        } else if (!active) {
          setPressed(true);
          voiceRecorder.wake(); // AudioContext в жесте (iOS) — дёшево, без микрофона
          const touchAt = Date.now();
          g.primeTimer = setTimeout(() => {
            g.primeTimer = null;
            if (gesture.current === g && g.mode === "pending") voiceRecorder.prime(touchAt);
          }, PRIME_DELAY_MS);
          const pointerId = e.nativeEvent.pointerId;
          g.timer = setTimeout(() => {
            g.timer = null;
            if (gesture.current !== g || g.mode !== "pending") return;
            g.mode = "hold";
            voiceRecorder.pressStart(target(), pointerId, { hold: true });
          }, HOLD_START_MS);
        }
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (g === null || g.pointerId !== e.pointerId) return;
        if (g.mode !== "drag") {
          const moved = Math.hypot(e.clientX - g.x0, e.clientY - g.y0);
          if (moved < (g.mode === "hold" ? HOLD_DRAG_PX : DRAG_PX)) return;
          if (g.mode === "hold" || g.mode === "start") {
            voiceRecorder.cancel("drag"); // перенос, а не диктовка — без вставки
          }
          if (g.mode === "pending") {
            clearTimer(g);
            voiceRecorder.unprime();
            setPressed(false);
          }
          g.mode = "drag";
          setDragging(true);
        }
        // Кнопка ездит только в видимой области — не уходит под клавиатуру.
        const a = readVisibleArea();
        const left = Math.min(
          Math.max(e.clientX - g.dx, a.x + FAB_MARGIN),
          a.x + a.w - FAB_SIZE - FAB_MARGIN,
        );
        const top = Math.min(
          Math.max(e.clientY - g.dy, a.y + FAB_MARGIN),
          a.y + a.h - FAB_SIZE - FAB_MARGIN,
        );
        g.last = { left, top };
        // Прямо в DOM — кадр за кадром, без перерисовки React.
        const el = e.currentTarget;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = "auto";
      }}
      onPointerUp={(e) => finishGesture(e, false)}
      onPointerCancel={(e) => finishGesture(e, true)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MicGlyph size={22} />
    </button>
  );
}

/** Питание настройки liveInput в синглтон — выключает все входы (§7). */
function SettingsBridge() {
  const { values } = useSettings();
  const enabled = values?.liveInput !== false;
  useEffect(() => {
    voiceRecorder.setLiveEnabled(enabled);
  }, [enabled]);
  const warm = values?.micWarmSeconds;
  useEffect(() => {
    voiceRecorder.setWarmMs(typeof warm === "number" ? warm * 1000 : DEFAULT_WARM_MS);
  }, [warm]);
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

/**
 * Тап по плашке (§3.2): запись → завершить и вставить; результат без
 * композера → скопировать и закрыть; done/error → закрыть. Никаких
 * отдельных кнопок — плашка сама и есть кнопка.
 */
function onCardTap(view: RecorderView): void {
  if (view.phase === "recording" || view.phase === "reconnecting") {
    voiceRecorder.stop();
    return;
  }
  if (view.phase === "finishing") return;
  if (view.phase === "done" && view.finalText !== null) {
    const text = view.finalText;
    void navigator.clipboard
      .writeText(text)
      .catch(() => undefined)
      .finally(() => voiceRecorder.dismiss());
    return;
  }
  voiceRecorder.dismiss();
}

function cardHint(view: RecorderView): string | null {
  if (view.phase === "recording" || view.phase === "reconnecting") {
    // До первого звука показываем только проблемы (перезапуск/запасной режим).
    if (!view.micLive) return view.notice !== null && view.notice !== "подключение…" ? view.notice : null;
    // Звук уже пишется и буферизуется — «подключение…» к серверу не мешает говорить.
    const notice = view.notice === "подключение…" ? null : view.notice;
    return notice ?? (view.holdArmed ? "Держите — или отпустите для toggle" : "Нажмите на плашку — вставить");
  }
  if (view.phase === "finishing") return view.notice;
  if (view.phase === "done" && view.finalText !== null) return "Нажмите — скопировать";
  if (view.phase === "error") return "Запись отменена. Проверьте настройки плагина.";
  return null;
}

export function RecordingOverlay() {
  const view = useSyncExternalStore(voiceRecorder.subscribe, voiceRecorder.getSnapshot);
  const area = useVisibleArea();
  const { values } = useSettings();
  const [now, setNow] = useState(() => Date.now());

  const active =
    view.phase === "recording" || view.phase === "reconnecting" || view.phase === "finishing";
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);

  const recording = view.phase === "recording" || view.phase === "reconnecting";
  const hint = cardHint(view);
  const body = recording
    ? view.interim !== ""
      ? view.interim
      : view.micLive
        ? "Говорите…"
        : "Включаю микрофон…"
    : view.phase === "done"
      ? view.finalText
      : null;

  return (
    <>
      <ComposersBridge />
      <SettingsBridge />
      {values?.liveInput !== false && <FloatingMic />}
      {view.phase === "idle" ? null : (
        <div
          className="vsl-overlay"
          role="status"
          aria-live="polite"
          // Над клавиатурой: базовый отступ 96px + закрытая снизу часть окна.
          style={area.keyboard > 0 ? { bottom: 96 + area.keyboard } : undefined}
        >
          <button
            type="button"
            className={`vsl-card vsl-card--tap${view.ignorePulse % 2 === 1 ? " vsl-card--shake" : ""}`}
            aria-label={recording ? "Завершить диктовку и вставить" : "Закрыть"}
            onClick={() => onCardTap(view)}
          >
            <span className="vsl-row vsl-row--head">
              {recording ? (
                <>
                  <span className={`vsl-dot${view.micLive ? "" : " vsl-dot--wait"}`} aria-hidden="true" />
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
            </span>
            {body !== null && <span className="vsl-interim">{body}</span>}
            {hint !== null && <span className="vsl-hint">{hint}</span>}
          </button>
        </div>
      )}
    </>
  );
}
