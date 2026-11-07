/**
 * Синглтон записи живого ввода — состояние уровня приложения, не компонента
 * (спека voice-stt-live §3.3): компоненты кнопки перемонтируются при смене
 * раскладки и навигации, запись прерываться не должна.
 *
 * Модель нажатия гибридная (§3.3): hold > 400 мс — «держи и говори»,
 * отпускание → end; тап < 400 мс — toggle, повторное нажатие или Enter → end.
 * Клиент держит СВОЮ копию всего PCM (§4.3а): на отпускании при мёртвом
 * сокете — новая сессия с реплеем; реконнект не удался за 5 с → WAV →
 * файловая цепочка через RPC liveFallback.
 */
import { pcmToWav } from "../wav.js";
import { MicCapture, type CaptureEvent, type MicCaptureLike } from "./capture.js";
import { rpc, type LiveFallbackResult, type LiveTokenResult } from "./rpc.js";

const WS_PATH = "/api/v1/plugins/voice-stt/http/live-voice";
const HOLD_MS = 400;
const MAX_RECORD_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 5_000;
const RECONNECT_TIMEOUT_MS = 5_000;
const DONE_DISMISS_MS = 1_600;
/** Вачдог финала (§4.4/§5): settle ≤6 c + фоллбэк codex→groq ≤30 c + запас. */
const FINAL_TIMEOUT_MS = 40_000;

export type RecorderPhase =
  | "idle"
  | "recording"
  | "reconnecting"
  | "finishing"
  | "done"
  | "error";

export interface RecorderView {
  phase: RecorderPhase;
  startedAt: number | null;
  /** Живой интерим-текст для оверлея (единственное место показа, §3.2). */
  interim: string;
  notice: string | null;
  /** Финал, который НЕ удалось вставить — остаётся в оверлее с «копировать». */
  finalText: string | null;
  engine: string | null;
  degraded: boolean;
  inserted: boolean;
  error: string | null;
  level: number;
  /** Пришёл первый звук с микрофона — можно говорить (до этого «включаю микрофон»). */
  micLive: boolean;
  /** Первые 400 мс после pointerdown — ещё не решено, hold или тап. */
  holdArmed: boolean;
  /** Счётчик проигнорированных нажатий во время busy — визуальный фидбэк. */
  ignorePulse: number;
}

const IDLE_VIEW: RecorderView = {
  phase: "idle",
  startedAt: null,
  interim: "",
  notice: null,
  finalText: null,
  engine: null,
  degraded: false,
  inserted: false,
  error: null,
  level: 0,
  micLive: false,
  holdArmed: false,
  ignorePulse: 0,
};

/** Минимум хендла композера для синглтона (структурно = PluginComposerApi). */
export interface ComposerTarget {
  readonly key: string;
  insert(parts: string, options?: { at?: "cursor" | "end" }): void;
  focus?(): void;
}

/** Браузерный сокет — структурный минимум DOM WebSocket. */
export interface RecorderSock {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  binaryType?: string;
}

const SOCK_OPEN = 1;

type ServerFrame =
  | { type: "ready" }
  | { type: "interim"; text: string }
  | { type: "final"; text: string; engine: string; degraded?: boolean }
  | { type: "error"; code: string; message: string };

export interface RecorderDeps {
  rpc?: (method: string, input?: object) => Promise<unknown>;
  wsFactory?: (url: string) => RecorderSock;
  wsUrl?: () => string;
  capture?: MicCaptureLike;
  now?: () => number;
  holdMs?: number;
  maxRecordMs?: number;
  readyTimeoutMs?: number;
  reconnectTimeoutMs?: number;
  finalTimeoutMs?: number;
  doneDismissMs?: number;
  listenKeys?: boolean;
  listenPagehide?: boolean;
}

interface Attempt {
  sock: RecorderSock | null;
  helloSent: boolean;
  dead: boolean;
}

type Listener = () => void;

function concatPcm(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function u8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function createVoiceRecorder(deps: RecorderDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const callRpc = deps.rpc ?? ((method: string, input: object = {}) => rpc(method, input));
  const wsUrl =
    deps.wsUrl ??
    (() => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${location.host}${WS_PATH}`;
    });
  const wsFactory =
    deps.wsFactory ??
    ((url: string) => {
      const sock = new WebSocket(url) as unknown as RecorderSock;
      sock.binaryType = "arraybuffer";
      return sock;
    });
  const capture = deps.capture ?? new MicCapture();
  const holdMs = deps.holdMs ?? HOLD_MS;
  const maxRecordMs = deps.maxRecordMs ?? MAX_RECORD_MS;
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const reconnectTimeoutMs = deps.reconnectTimeoutMs ?? RECONNECT_TIMEOUT_MS;
  const finalTimeoutMs = deps.finalTimeoutMs ?? FINAL_TIMEOUT_MS;
  const doneDismissMs = deps.doneDismissMs ?? DONE_DISMISS_MS;
  const listenKeys = deps.listenKeys ?? typeof window !== "undefined";
  const listenPagehide = deps.listenPagehide ?? typeof window !== "undefined";

  let view: RecorderView = { ...IDLE_VIEW };
  const listeners = new Set<Listener>();
  const patch = (next: Partial<RecorderView>): void => {
    view = { ...view, ...next };
    for (const fn of listeners) fn();
  };

  let target: ComposerTarget | null = null;
  let targetResolver: (() => ComposerTarget | null) | null = null;
  let liveEnabled = true;
  let attempt: Attempt | null = null;
  let pcm: Uint8Array[] = [];
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  let lastLevelAt = 0;
  let keysAttached = false;
  let readySeen = false;
  let lastReleaseStamp = -1;
  /**
   * Физически удерживаемый пресс и его pointerId (§3.3): window pointerup
   * кончает запись только пока исходный пресс ещё нажат. Без этого ЛЮБОЕ
   * отпускание в toggle-режиме (клик/скролл/выделение, в т.ч. по оверлею)
   * обрывало бы диктовку — пост-ревью, блокер.
   */
  let pressHeld = false;
  let activePointerId: number | null = null;

  const arm = (fn: () => void, ms: number): void => {
    timers.push(setTimeout(fn, ms));
  };
  const armFinishWatchdog = (): void => {
    arm(() => {
      if (view.phase === "finishing") void fileFallback();
    }, finalTimeoutMs);
  };
  /**
   * Таймер авто-скрытия done-оверлея живёт ОТДЕЛЬНО от timers (пост-ревью,
   * блокер): deliver армит его после teardown — обычный clearTimers его не
   * снимает, а срабатывание посреди следующей записи ставило view в idle
   * с мёртвыми Esc/Enter. Чистится на dismiss/pressStart/teardown.
   */
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  const clearDismiss = (): void => {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  };
  const armDismiss = (): void => {
    clearDismiss();
    dismissTimer = setTimeout(() => {
      dismissTimer = null;
      if (view.phase === "done") patch({ ...IDLE_VIEW, ignorePulse: view.ignorePulse });
    }, doneDismissMs);
  };
  const clearTimers = (): void => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (view.phase === "idle") return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      recorder.cancel("esc");
      return;
    }
    if (ev.key === "Enter") {
      // Enter в оверлее → end + вставка; submit черновика — НИКОГДА (§3.3).
      ev.preventDefault();
      ev.stopPropagation();
      recorder.stop();
    }
  };

  const onWindowRelease = (ev: Event): void => {
    // Отпускание вне кнопки (уехал палец/курсор) — тот же жест конца.
    recorder.pressEnd(ev as PointerEvent);
  };

  const attachWindowHooks = (): void => {
    if (typeof window === "undefined") return;
    if (listenKeys && !keysAttached) {
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("pointerup", onWindowRelease);
      window.addEventListener("pointercancel", onWindowRelease);
      keysAttached = true;
    }
    if (listenPagehide) {
      window.addEventListener("pagehide", onPageHide, { once: true });
    }
  };
  const detachWindowHooks = (): void => {
    if (typeof window === "undefined") return;
    if (keysAttached) {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerup", onWindowRelease);
      window.removeEventListener("pointercancel", onWindowRelease);
      keysAttached = false;
    }
    if (listenPagehide) {
      window.removeEventListener("pagehide", onPageHide);
    }
  };
  const onPageHide = (): void => {
    recorder.cancel("pagehide");
  };

  /**
   * Диагностика захвата → лог сервера. До hello копим в очередь и
   * отправляем сразу после него (§8.1).
   */
  let diagQueue: string[] = [];
  const sendDiag = (msg: string): void => {
    const a = attempt;
    if (a && !a.dead && a.helloSent && a.sock?.readyState === SOCK_OPEN) {
      sendJson(a, { type: "diag", msg });
    } else if (diagQueue.length < 20) {
      diagQueue.push(msg);
    }
  };
  const flushDiag = (a: Attempt): void => {
    const q = diagQueue;
    diagQueue = [];
    for (const msg of q) sendJson(a, { type: "diag", msg });
  };
  const onCaptureEvent = (ev: CaptureEvent): void => {
    const live = view.phase === "recording" || view.phase === "reconnecting";
    if (!live && standby === null) return;
    if (!live) {
      // Предзахват: только в лог (уйдёт после hello), без плашки.
      if (ev.kind === "started") sendDiag(`mic started (pre-roll): ${ev.info}`);
      else sendDiag(`mic ${ev.kind} (pre-roll): ${"info" in ev ? ev.info : ev.reason}`);
      return;
    }
    if (ev.kind === "started") sendDiag(`mic started: ${ev.info}`);
    else if (ev.kind === "state") sendDiag(`mic ${ev.info}`);
    else if (ev.kind === "stall") {
      sendDiag(`mic stall: ${ev.reason}`);
      patch({ notice: "микрофон пропал — перезапускаю…" });
    } else if (ev.kind === "restarted") {
      sendDiag(`mic restarted: ${ev.info}`);
      patch({ notice: null });
    } else {
      sendDiag(`mic failed: ${ev.reason}`);
      patch({ notice: "микрофон не отвечает — проверьте устройство ввода в системе" });
    }
  };

  /**
   * Предзахват (касание FAB на телефоне): микрофон поднимается на касании,
   * звук копится в preroll; если касание стало тапом/удержанием — preroll
   * уходит в начало записи, если переносом — всё гасится. Включение
   * микрофона на iOS ~0.5–1 с — так оно идёт параллельно с жестом.
   */
  let standby: Promise<void> | null = null;
  let standbyError: unknown = null;
  let preroll: Uint8Array[] = [];
  let prerollBytes = 0;
  const PREROLL_MAX_BYTES = 64_000; // ~2 с PCM16 16 кГц
  /** Диагностика задержки «нажатие → первый звук». */
  let pressAt = 0;
  let firstAudioAt = 0;

  const sendJson = (a: Attempt, frame: object): void => {
    try {
      if (a.sock?.readyState === SOCK_OPEN) a.sock.send(JSON.stringify(frame));
    } catch {
      // сокет умер при отправке — путь фоллбэка покроет
    }
  };

  const onMicChunk = (bytes: Uint8Array, level: number): void => {
    // Поздний чанк после cancel/stop — не запись: generation-гард в
    // capture не пускает поток, это вторая линия (блокер «сирота»).
    if (firstAudioAt === 0) firstAudioAt = now();
    if (view.phase === "idle" && standby !== null) {
      preroll.push(bytes);
      prerollBytes += bytes.byteLength;
      while (prerollBytes > PREROLL_MAX_BYTES && preroll.length > 1) {
        prerollBytes -= preroll[0].byteLength;
        preroll.shift();
      }
      return;
    }
    if (attempt === null) return;
    if (view.phase !== "recording" && view.phase !== "reconnecting") return;
    if (!view.micLive) sendDiag(`mic first audio ${firstAudioAt - pressAt}ms after press`);
    pcm.push(bytes);
    const a = attempt;
    if (a?.helloSent && a.sock?.readyState === SOCK_OPEN) {
      try {
        a.sock.send(bytes);
      } catch {
        // кадр остался в pcm — долетит реплеем
      }
    }
    const t = now();
    if (!view.micLive) {
      lastLevelAt = t;
      patch({ level, micLive: true });
    } else if (t - lastLevelAt > 90) {
      lastLevelAt = t;
      patch({ level });
    }
  };

  const teardown = (): void => {
    const a = attempt;
    attempt = null;
    clearTimers();
    clearDismiss();
    detachWindowHooks();
    if (a) {
      a.dead = true;
      try {
        a.sock?.close();
      } catch {
        // уже закрыт
      }
    }
    capture.stop();
    standby = null;
    preroll = [];
    prerollBytes = 0;
  };

  const fail = (message: string): void => {
    // Отменённая сессия не воскрешает оверлей поздней ошибкой.
    if (view.phase === "idle") return;
    // Причина — в лог сервера (диагностика «то работает, то нет»).
    const a = attempt;
    if (a && !a.dead && a.helloSent) sendJson(a, { type: "cancel", reason: `client error: ${message}` });
    teardown();
    patch({ phase: "error", error: message, notice: null, holdArmed: false });
  };

  /**
   * Финал в черновик: insert по сохранённому хендлу ({at:"end"} работает и
   * для композера вне экрана). Композер ушёл/редактор закрыт → текст
   * остаётся в оверлее с «копировать» — тихих потерь нет (§3.3).
   */
  const deliver = (text: string, engine: string, degraded: boolean): void => {
    // Финал приходит только из finishing; cancel во время ожидания (в т.ч.
    // в полёте WAV-фоллбэка) — результат больше не вставляем.
    if (view.phase !== "finishing") return;
    teardown();
    if (engine === "silence" || text.trim() === "") {
      patch({
        phase: "done",
        interim: "",
        notice: "тишина — ничего не распознано",
        engine,
        degraded,
        inserted: false,
        finalText: null,
        holdArmed: false,
      });
      armDismiss();
      return;
    }
    let inserted = false;
    if (target !== null) {
      try {
        target.insert(text, { at: "end" });
        inserted = true;
        try {
          target.focus?.();
        } catch {
          // фокус — best effort
        }
      } catch {
        inserted = false;
      }
    }
    patch({
      phase: "done",
      interim: "",
      engine,
      degraded,
      inserted,
      finalText: inserted ? null : text,
      notice: inserted ? "вставлено в черновик" : "композер недоступен — текст ниже",
      holdArmed: false,
    });
    if (inserted) {
      armDismiss();
    }
  };

  /** Файловая цепочка (§4.3а): WAV → RPC liveFallback → codex→groq(+gemini). */
  const fileFallback = async (): Promise<void> => {
    if (view.phase !== "finishing") return; // двойной запуск не нужен
    patch({ notice: "фоллбэк на файловую цепочку…" });
    try {
      const wav = pcmToWav(concatPcm(pcm));
      const res = await callRpc("liveFallback", {
        audioBase64: u8ToBase64(wav),
        filename: "live-dictation.wav",
      }) as LiveFallbackResult;
      if (res.ok) {
        deliver(res.text, res.engine, true);
      } else {
        fail(`фоллбэк не сработал: ${res.message}`);
      }
    } catch (e) {
      fail(`фоллбэк не сработал: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Мёртвый сокет на отпускании (§4.3а): новая сессия, реплей всего PCM
   * (эквивалент файлового blast), end сразу за ним. Не удалось за 5 с →
   * файловая цепочка.
   */
  const replayAndFinish = (): void => {
    // Старая попытка гасится: её кадры и close больше ни на что не влияют.
    const old = attempt;
    if (old !== null) {
      old.dead = true;
      try {
        old.sock?.close();
      } catch {
        // уже закрыт
      }
    }
    const a: Attempt = { sock: null, helloSent: false, dead: false };
    attempt = a;
    const snapshot = pcm;
    let busyRetries = 0;
    arm(() => {
      if (attempt === a && !a.helloSent) {
        a.dead = true;
        try {
          a.sock?.close();
        } catch {
          // уже закрыт
        }
        void fileFallback();
      }
    }, reconnectTimeoutMs);
    const openReplay = (): void => {
      let sock: RecorderSock;
      try {
        sock = wsFactory(wsUrl());
      } catch {
        void fileFallback();
        return;
      }
      a.sock = sock;
      sock.onopen = () => {
        void (async () => {
          try {
            const res = (await callRpc("liveToken", {})) as LiveTokenResult;
            if (a.dead) return;
            sock.send(JSON.stringify({ type: "hello", token: res.token }));
            a.helloSent = true;
            for (const chunk of snapshot) sock.send(chunk);
            sock.send(JSON.stringify({ type: "end" }));
            armFinishWatchdog();
          } catch {
            if (!a.dead) void fileFallback();
          }
        })();
      };
      sock.onmessage = (ev) => onServerMessage(a, ev.data);
      sock.onclose = (ev) => {
        if (a.dead) return;
        // Сервер ещё не успел снести старое соединение — пара ретраев (§4.3а-гонка).
        if (ev.code === 4009 && busyRetries < 2) {
          busyRetries += 1;
          setTimeout(() => {
            if (!a.dead) openReplay();
          }, 250);
          return;
        }
        void fileFallback();
      };
      sock.onerror = () => {
        if (!a.dead) void fileFallback();
      };
    };
    openReplay();
  };

  const onServerMessage = (a: Attempt, data: unknown): void => {
    if (a.dead || typeof data !== "string") return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data) as ServerFrame;
    } catch {
      return;
    }
    if (frame.type === "ready") {
      readySeen = true;
      patch({ notice: null });
      return;
    }
    if (frame.type === "interim") {
      patch({ interim: frame.text });
      return;
    }
    if (frame.type === "final") {
      deliver(frame.text, frame.engine, frame.degraded === true);
      return;
    }
    if (frame.type === "error") {
      if (view.phase === "finishing") {
        // Сервер не смог финиш — §4.3а: у клиента весь PCM → WAV-фоллбэк.
        a.dead = true;
        try {
          a.sock?.close();
        } catch {
          // уже закрыт
        }
        void fileFallback();
        return;
      }
      if (view.phase === "recording" || view.phase === "reconnecting") {
        // Серверная сессия умерла посреди записи — у нас есть весь PCM,
        // на отпускании уйдём реплеем/файлом (§4.3а).
        a.dead = true;
        try {
          a.sock?.close();
        } catch {
          // уже закрыт
        }
        patch({ phase: "reconnecting", notice: frame.message });
        return;
      }
      fail(frame.message);
    }
  };

  const openSocket = (): void => {
    const a: Attempt = { sock: null, helloSent: false, dead: false };
    attempt = a;
    arm(() => {
      // §8: без ready дольше 5 с → error + отмена.
      if (attempt === a && !a.dead && view.phase === "recording" && !readySeen) {
        fail("сервер живого ввода не ответил за 5 с");
      }
    }, readyTimeoutMs);
    let sock: RecorderSock;
    try {
      sock = wsFactory(wsUrl());
    } catch (e) {
      fail(`не удалось открыть сокет: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    a.sock = sock;
    sock.onopen = () => {
      void (async () => {
        try {
          const res = (await callRpc("liveToken", {})) as LiveTokenResult;
          if (a.dead || attempt !== a) return;
          // hello → сразу поток PCM, ready не ждём (§4.2): сервер буферит.
          sock.send(JSON.stringify({ type: "hello", token: res.token }));
          a.helloSent = true;
          for (const chunk of pcm) sock.send(chunk);
          flushDiag(a);
        } catch (e) {
          if (!a.dead && attempt === a) {
            fail(`сервер живого ввода недоступен: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      })();
    };
    sock.onmessage = (ev) => onServerMessage(a, ev.data);
    sock.onclose = () => {
      if (a.dead || attempt !== a) return;
      a.dead = true;
      if (view.phase === "recording") {
        // Обрыв посреди записи: захват идёт дальше локально (§4.3а).
        patch({ phase: "reconnecting", notice: "переподключение…" });
        return;
      }
      if (view.phase === "finishing") {
        void replayAndFinish();
      }
    };
    sock.onerror = () => {
      if (a.dead || attempt !== a) return;
      a.dead = true;
      if (view.phase === "recording") {
        patch({ phase: "reconnecting", notice: "переподключение…" });
      } else if (view.phase === "finishing") {
        void replayAndFinish();
      } else {
        fail("не удалось подключиться к серверу живого ввода");
      }
    };
  };

  const recorder = {
    subscribe(fn: Listener): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot(): RecorderView {
      return view;
    },

    /** Питание настройки liveInput — выключает все входы разом (§7). */
    setLiveEnabled(enabled: boolean): void {
      liveEnabled = enabled;
      if (!enabled && view.phase !== "idle") recorder.cancel("live input disabled");
    },
    isLiveEnabled(): boolean {
      return liveEnabled;
    },
    isActive(): boolean {
      return view.phase === "recording" || view.phase === "reconnecting" || view.phase === "finishing";
    },

    /** Резолвер «primary/focused» композера — ставит ComposersBridge. */
    setTargetResolver(resolver: (() => ComposerTarget | null) | null): void {
      targetResolver = resolver;
    },

    /**
     * pointerdown на кнопке: старт немедленно (прогрев §3.3), iOS-unlock в
     * жесте. `pointerId` — только у реального указателя; команда/футер
     * стартуют без него (pressHeld=false → чужие отпускания игнорятся).
     */
    /**
     * Касание FAB в покое: только будим AudioContext в жесте (требование
     * iOS) — без микрофона и сокета, чтобы перенос кнопки не тормозил.
     */
    prime(): void {
      if (view.phase !== "idle") return;
      capture.unlock(); // в жесте — требование iOS
      if (standby !== null) return;
      pressAt = now();
      firstAudioAt = 0;
      diagQueue = [];
      preroll = [];
      prerollBytes = 0;
      standbyError = null;
      standby = capture.start(onMicChunk, onCaptureEvent).catch((e: unknown) => {
        standbyError = e;
      });
    },
    /** Касание оказалось переносом — предзахват и контекст гасим. */
    unprime(): void {
      if (view.phase !== "idle") return;
      capture.stop();
      standby = null;
      preroll = [];
      prerollBytes = 0;
    },

    pressStart(
      composer?: ComposerTarget | null,
      pointerId?: number,
      opts?: { hold?: boolean },
    ): void {
      if (!liveEnabled) return;
      if (view.phase === "recording" || view.phase === "reconnecting") {
        // Повторное нажатие в toggle-режиме → end (§3.3).
        recorder.stop();
        return;
      }
      if (view.phase !== "idle") {
        patch({ ignorePulse: view.ignorePulse + 1 });
        return;
      }
      pressHeld = pointerId !== undefined;
      activePointerId = pointerId ?? null;
      clearDismiss(); // протухший авто-скрыватель не должен жить в новой сессии
      target = composer ?? null;
      // Предзахват уже идёт — его звук становится началом записи.
      const sb = standby;
      standby = null;
      pcm = sb !== null ? preroll : [];
      preroll = [];
      prerollBytes = 0;
      if (sb === null) {
        diagQueue = [];
        pressAt = now();
        firstAudioAt = 0;
      }
      readySeen = false;
      patch({
        ...IDLE_VIEW,
        phase: "recording",
        startedAt: now(),
        holdArmed: true,
        notice: "подключение…",
        ignorePulse: view.ignorePulse,
        micLive: pcm.length > 0,
      });
      if (pcm.length > 0) sendDiag(`mic first audio ${firstAudioAt - pressAt}ms after press (pre-roll ${pcm.length} chunks)`);
      capture.unlock(); // синхронно в нажатии — требование iOS (§3.3)
      attachWindowHooks();
      if (opts?.hold === true) {
        // Удержание уже распознано (FAB): отпускание = конец записи.
        patch({ holdArmed: false, notice: view.notice });
      } else {
        arm(() => patch({ holdArmed: false }), holdMs);
      }
      arm(() => {
        if (view.phase === "recording" || view.phase === "reconnecting") {
          patch({ notice: "лимит 5 минут — завершаю" });
          recorder.stop();
        }
      }, maxRecordMs);
      openSocket();
      if (sb !== null) {
        void sb.then(() => {
          if (standbyError !== null && (view.phase === "recording" || view.phase === "reconnecting")) {
            const e = standbyError;
            fail(`микрофон недоступен: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
        return;
      }
      void (async () => {
        try {
          await capture.start(onMicChunk, onCaptureEvent);
        } catch (e) {
          if (view.phase === "recording" || view.phase === "reconnecting") {
            fail(`микрофон недоступен: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      })();
    },

    /**
     * Отпускание ИСХОДНОГО пресса: <400 мс — toggle (запись продолжается),
     * иначе → end. Игнорится, когда пресс не удерживается (toggle-режим:
     * конец — только повторное нажатие кнопки или Enter, §3.3) или когда
     * pointerId чужой. Одно отпускание приходит и в React-кнопку, и в
     * window — дедупликация по timeStamp + сброс pressHeld.
     */
    pressEnd(ev?: { timeStamp?: number; pointerId?: number }): void {
      if (!pressHeld) return;
      if (
        activePointerId !== null &&
        ev?.pointerId !== undefined &&
        ev.pointerId !== activePointerId
      ) {
        return;
      }
      pressHeld = false;
      activePointerId = null;
      if (ev?.timeStamp !== undefined) {
        if (ev.timeStamp === lastReleaseStamp) return;
        lastReleaseStamp = ev.timeStamp;
      }
      if (view.phase !== "recording" && view.phase !== "reconnecting") return;
      if (view.holdArmed) {
        patch({ holdArmed: false, notice: null });
        return;
      }
      recorder.stop();
    },

    /** Команда/футер: запись → end; idle → старт с резолвом цели. */
    toggle(composer?: ComposerTarget | null): void {
      if (!liveEnabled) return;
      if (view.phase === "recording" || view.phase === "reconnecting") {
        recorder.stop();
        return;
      }
      if (view.phase !== "idle") return;
      recorder.pressStart(composer ?? targetResolver?.() ?? null);
      // Команда — не hold: сразу снимаем «дедлайн удержания».
      patch({ holdArmed: false });
    },

    /** Отпускание/Enter: конец записи → final → вставка (§3.3). */
    stop(): void {
      if (view.phase !== "recording" && view.phase !== "reconnecting") return;
      patch({ phase: "finishing", notice: "обработка…", holdArmed: false });
      capture.stop(); // отпустили — микрофон больше не пишем
      const a = attempt;
      if (a && !a.dead && a.helloSent && a.sock?.readyState === SOCK_OPEN) {
        sendJson(a, { type: "end" });
        // Вачдог финала: тишина от сервера сверх бюджета → WAV-фоллбэк.
        armFinishWatchdog();
      } else {
        // Сокет мёртв/не поднялся — реплей всей записи в новую сессию (§4.3а).
        void replayAndFinish();
      }
    },

    /** Esc/уход со страницы: без вставки и без отправки на движки (§3.3). */
    cancel(reason = "user"): void {
      const a = attempt;
      if (a && !a.dead && a.helloSent) sendJson(a, { type: "cancel", reason });
      teardown();
      patch({ ...IDLE_VIEW, ignorePulse: view.ignorePulse });
    },

    /** Закрыть оверлей результата/ошибки. */
    dismiss(): void {
      if (view.phase === "recording" || view.phase === "reconnecting" || view.phase === "finishing") {
        recorder.cancel("dismiss");
        return;
      }
      clearDismiss();
      patch({ ...IDLE_VIEW, ignorePulse: view.ignorePulse });
    },
  };

  return recorder;
}

export type VoiceRecorder = ReturnType<typeof createVoiceRecorder>;

/** Синглтон приложения (§3.3). */
export const voiceRecorder = createVoiceRecorder();
