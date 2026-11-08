/**
 * Захват микрофона для живого ввода — адаптация проверенного живыми звонками
 * движка live-call (src/ui/engine.ts): AudioWorklet с прореживанием до
 * 16 кГц, запасной ScriptProcessor на старых WebKit, синхронная разблокировка
 * AudioContext в обработчике указателя (требование iOS).
 *
 * Только захват: плеера нет (диктовка, не звонок). Чанки отдаются как
 * PCM16 s16le mono 16 кГц — ровно то, что ждёт сервер (§4.2).
 */

const WORKLET_SOURCE = `
class VoiceSttCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.buffer = new Float32Array(800); // 50 мс при 16 кГц — первый звук раньше
    this.filled = 0;
    this.pos = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        if (this.filled < this.buffer.length) this.buffer[this.filled++] = ch[i];
      }
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0, this.filled));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("voice-stt-capture", VoiceSttCapture);
`;

/** События захвата — для плашки и диагностики в логе сервера. */
export type CaptureEvent =
  | { kind: "started"; info: string }
  | { kind: "state"; info: string }
  | { kind: "stall"; reason: string }
  | { kind: "restarted"; info: string }
  | { kind: "failed"; reason: string }
  /** Web Audio молчит — запись идёт через MediaRecorder, текст после конца записи. */
  | { kind: "fallback"; info: string }
  /** Web Audio молчит — MediaRecorder + раскодирование на лету: живой поток сохраняется. */
  | { kind: "stream"; info: string };

/**
 * Web Audio на этой странице признан мёртвым (до перезагрузки страницы).
 * iOS WebKit после прерывания аудиосессии (звонок, Siri, чужой звук,
 * блокировка) оставляет AudioContext «running», но граф не рендерит ни
 * кадра — лечится только перезапуском приложения (лог 07.11: mic stall
 * ×3 → 0 КБ). Нативный микрофон bb пишет MediaRecorder-ом и живёт —
 * следующие записи сразу идут так же, без 3–4 с попыток.
 */
let webAudioBroken = false;

/** Потоковый запасной режим: кусок MediaRecorder, хвост и размер отдачи (16 кГц). */
const STREAM_SLICE_MS = 400;
const STREAM_HOLDBACK_SAMPLES = 1024; // ~64 мс
const STREAM_EMIT_SAMPLES = 800; // 50 мс, как кадр worklet
const STREAM_MAX_DECODE_FAILS = 3;

/** Готовая запись запасного режима. */
export interface RecordedAudio {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

function pickRecorderMime(): string {
  const MR = (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!MR) return "";
  for (const m of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    try {
      if (MR.isTypeSupported(m)) return m;
    } catch {
      // старый WebKit без isTypeSupported
    }
  }
  return "";
}

function recorderSupported(): boolean {
  return typeof (window as unknown as { MediaRecorder?: unknown }).MediaRecorder === "function";
}

/** Один blob-URL модуля на страницу — не пересоздаём на каждую запись. */
let workletUrl: string | null = null;
function getWorkletUrl(): string {
  if (workletUrl === null) {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
  }
  return workletUrl;
}

/** Сколько звука до нажатия держит тёплый микрофон (≈0.5 с PCM16 16 кГц). */
const RING_MAX_BYTES = 16_000;

export interface MicCaptureLike {
  /** Синхронно создать и разбудить AudioContext — вызывать из pointer-обработчика. */
  unlock(): void;
  /**
   * Конец записи без выключения микрофона: цепочка живёт ms миллисекунд
   * («тёплый» микрофон), звук идёт только в кольцевой буфер ~0.5 с в
   * памяти и никуда не отправляется. Следующий start подхватывает
   * работающий микрофон мгновенно. ms ≤ 0 — то же, что stop().
   */
  park(ms: number): void;
  /** Запись идёт запасным режимом (MediaRecorder) — живого PCM нет. */
  isRecorderMode?(): boolean;
  /** Остановить запасную запись и отдать файл (null — пусто/нет режима). */
  finishRecording?(): Promise<RecordedAudio | null>;
  /** Запасной захват отдаёт PCM потоком (раскодирование на лету). */
  isStreaming?(): boolean;
  /** Дослать хвост потокового запасного захвата перед end. */
  flushStream?(): Promise<void>;
  /** Поднять getUserMedia + цепочку захвата; чанки идут в onChunk. */
  start(
    onChunk: (pcm: Uint8Array, level: number) => void,
    onEvent?: (ev: CaptureEvent) => void,
  ): Promise<void>;
  stop(): void;
}

/** Нет ни одного кадра дольше — захват встал (контекст/устройство). */
const STALL_NO_FRAMES_MS = 1500;
/** Touch: повторная проверка после перезапуска со свежим контекстом. */
const STALL_NO_FRAMES_AFTER_RESTART_MS = 1000;
/** Только абсолютные нули дольше — микрофон «подключён», но звука нет. */
const STALL_ZEROS_MS = 2500;
const MAX_RESTARTS = 3;
const WATCH_MS = 500;

/**
 * Выбор микрофона (жалоба владельца 07.11). macOS через Continuity
 * подставляет микрофон соседнего iPhone как вход по умолчанию — браузерный
 * getUserMedia брал его, и на маке «запись идёт, звука нет» (нативные
 * приложения вроде OmniFlow берут встроенный микрофон). На десктопе
 * Apple-устройства-соседи (iPhone/iPad) исключаются, если есть другой
 * вход; предпочтение — устройство, с которого уже шёл звук, затем
 * «default» (если это не iPhone), затем встроенный микрофон.
 */
const CONTINUITY_RE = /iphone|ipad|continuity/i;
const BUILTIN_RE = /built-in|builtin|macbook|встроенн/i;
/** Виртуальные входы (лупбэк, конференц-драйверы) — без живого звука. */
const VIRTUAL_RE = /blackhole|soundflower|loopback|zoomaudio|zoom audio|teams audio|virtual|aggregate|background music|krisp/i;
const LAST_GOOD_KEY = "voice-stt:mic-device";

/** Мак/ПК, а не сам телефон: на iPhone его микрофон — свой, не чужой. */
function isDesktop(): boolean {
  const touch = (navigator.maxTouchPoints ?? 0) > 1;
  return !touch && !/iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

function loadLastGood(): string | null {
  try {
    return localStorage.getItem(LAST_GOOD_KEY);
  } catch {
    return null;
  }
}

function saveLastGood(id: string): void {
  try {
    localStorage.setItem(LAST_GOOD_KEY, id);
  } catch {
    // приватный режим — просто не запомним
  }
}

/** Ручной выбор микрофона в настройках — свой на каждом устройстве. */
export const MIC_CHOICE_KEY = "voice-stt:mic-choice";

export interface MicChoice {
  deviceId: string;
  label: string;
}

export function loadMicChoice(): MicChoice | null {
  try {
    const raw = localStorage.getItem(MIC_CHOICE_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<MicChoice>;
    return typeof v.deviceId === "string" && typeof v.label === "string" ? { deviceId: v.deviceId, label: v.label } : null;
  } catch {
    return null;
  }
}

/** null — «Авто». */
export function saveMicChoice(choice: MicChoice | null): void {
  try {
    if (choice === null) localStorage.removeItem(MIC_CHOICE_KEY);
    else localStorage.setItem(MIC_CHOICE_KEY, JSON.stringify(choice));
  } catch {
    // нет хранилища — выбор не запомнится
  }
}

/** Входы для списка в настройках (метки есть только после разрешения). */
export async function listInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput" && d.deviceId !== "" && d.deviceId !== "communications");
}

interface InputChoice {
  deviceId: string | null;
  why: string;
}

export async function pickInput(exclude: ReadonlySet<string>): Promise<InputChoice> {
  // Ручной выбор в настройках — на любом устройстве, пока это устройство есть.
  const manual = loadMicChoice();
  if (manual !== null && !exclude.has(manual.deviceId) && navigator.mediaDevices !== undefined) {
    try {
      const inputs = await listInputs();
      const hit =
        inputs.find((d) => d.deviceId === manual.deviceId) ??
        inputs.find((d) => d.label !== "" && d.label === manual.label);
      if (hit) return { deviceId: hit.deviceId, why: "manual" };
    } catch {
      // перечислить не вышло — авто
    }
  }
  if (!isDesktop() || !navigator.mediaDevices?.enumerateDevices) {
    return { deviceId: null, why: "system default" };
  }
  let inputs: MediaDeviceInfo[];
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "audioinput" && d.deviceId !== "communications",
    );
  } catch {
    return { deviceId: null, why: "enumerate failed → default" };
  }
  // Без разрешения меток нет — выбрать нельзя, берём default (разберётся сторож).
  if (inputs.length === 0 || inputs.every((d) => d.label === "")) {
    return { deviceId: null, why: "no labels yet → default" };
  }
  const usable = inputs.filter(
    (d) =>
      d.deviceId !== "" &&
      !CONTINUITY_RE.test(d.label) &&
      !VIRTUAL_RE.test(d.label) &&
      !exclude.has(d.deviceId),
  );
  if (usable.length === 0) return { deviceId: null, why: "only continuity/excluded inputs → default" };
  const last = loadLastGood();
  const byLast = last !== null ? usable.find((d) => d.deviceId === last) : undefined;
  if (byLast) return { deviceId: byLast.deviceId, why: "last good" };
  const def = usable.find((d) => d.deviceId === "default");
  if (def) return { deviceId: def.deviceId, why: "default (not iPhone)" };
  const builtin = usable.find((d) => BUILTIN_RE.test(d.label));
  if (builtin) return { deviceId: builtin.deviceId, why: "built-in" };
  return { deviceId: usable[0].deviceId, why: "first non-iPhone" };
}

type AC = typeof AudioContext;
function audioContextCtor(): AC | undefined {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext
  );
}

export class MicCapture implements MicCaptureLike {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private captureNode: AudioNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  /**
   * Поколение захвата (пост-ревью, блокер «сирота-микрофон»): cancel/stop
   * во время pending getUserMedia — окно промпта секунды — не должен
   * дать ожившему await поднять поток без индикатора записи. Каждый
   * await проверяет поколение; устаревшее → треки глушатся сразу.
   */
  private generation = 0;
  private onChunk: ((pcm: Uint8Array, level: number) => void) | null = null;
  private onEvent: (ev: CaptureEvent) => void = () => {};
  private watch: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private lastSoundAt = 0;
  private restarts = 0;
  private restarting = false;
  /** Устройства, давшие тишину в этой записи — при перезапуске пропускаем. */
  private badDevices = new Set<string>();
  private currentDeviceId: string | null = null;
  private soundSeen = false;
  private parked = false;
  private parkTimer: ReturnType<typeof setTimeout> | null = null;
  private ring: Uint8Array[] = [];
  private ringBytes = 0;
  private info = "";
  private mode: "webaudio" | "recorder" = "webaudio";
  private mr: MediaRecorder | null = null;
  private mrChunks: Blob[] = [];
  private mrMime = "";
  /**
   * Потоковый запасной режим: MediaRecorder режет запись кусками, весь
   * накопленный файл раскодируется decodeAudioData (OfflineAudioContext
   * 16 кГц — без звукового вывода, которого и нет у «мёртвого» Web Audio)
   * и новые сэмплы уходят тем же onChunk, что у worklet.
   */
  private streaming = false;
  private decodeCtx: OfflineAudioContext | null = null;
  private decodeBusy: Promise<void> | null = null;
  private decodeDirty = false;
  private sentSamples = 0;
  private decodeFails = 0;

  /** iOS: AudioContext живёт, только если создан и запущен прямо в нажатии. */
  unlock(): void {
    // Идемпотентно: FAB будит контекст на касании, pressStart — повторно.
    if (this.ctx !== null && this.ctx.state !== "closed") {
      void this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const Ctor = audioContextCtor();
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      void ctx.resume().catch(() => {});
      // Тихий сэмпл в том же нажатии — iOS после этого считает звук разрешённым.
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      this.ctx = null;
    }
  }

  async start(
    onChunk: (pcm: Uint8Array, level: number) => void,
    onEvent?: (ev: CaptureEvent) => void,
  ): Promise<void> {
    this.clearParkTimer();
    if (this.parked) {
      this.parked = false;
      if (this.mode === "recorder" && this.streamAlive()) {
        // Тёплый поток в запасном режиме: новый MediaRecorder без getUserMedia.
        this.onChunk = onChunk;
        this.onEvent = onEvent ?? (() => {});
        this.startRecorder("warm stream");
        return;
      }
      if (this.alive()) {
        // Тёплый микрофон: подхватываем без getUserMedia, плюс ~0.5 с звука до нажатия.
        this.onChunk = onChunk;
        this.onEvent = onEvent ?? (() => {});
        this.restarts = 0;
        this.badDevices = new Set();
        const pre = this.ring;
        this.ring = [];
        this.ringBytes = 0;
        void this.ctx?.resume().catch(() => {});
        const t = performance.now();
        this.lastFrameAt = t;
        this.lastSoundAt = t;
        for (const chunk of pre) onChunk(chunk, 0);
        this.onEvent({ kind: "started", info: `warm, ${pre.length} chunks before press; ${this.info}` });
        this.armWatch(this.generation);
        return;
      }
      this.stop(); // остыл/умер (фон, чужой захват) — холодный старт
    }
    this.onChunk = onChunk;
    this.onEvent = onEvent ?? (() => {});
    this.restarts = 0;
    this.badDevices = new Set();
    const gen = this.generation;
    const info = await this.open(gen);
    if (info === null) return;
    this.info = info;
    this.onEvent({ kind: "started", info });
    this.armWatch(gen);
  }

  /**
   * Поднять поток и цепочку. null — поколение устарело (stop во время await).
   * Контекст пересоздаётся ПОСЛЕ getUserMedia, если прежний не бежит или
   * его частота не совпадает с микрофоном: на macOS включение микрофона
   * (AirPods, смена устройства) перестраивает аудиоустройство, и контекст,
   * созданный до этого, встаёт или отдаёт тишину.
   */
  private async open(gen: number): Promise<string | null> {
    const stale = (): boolean => gen !== this.generation;
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    // Модуль обработки грузим параллельно с включением микрофона (контекст из жеста уже есть).
    const preCtx = this.ctx !== null && this.ctx.state !== "closed" ? this.ctx : null;
    const preModule =
      preCtx?.audioWorklet !== undefined
        ? preCtx.audioWorklet.addModule(getWorkletUrl()).then(
            () => true,
            () => false,
          )
        : null;
    let choice = await pickInput(this.badDevices);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: choice.deviceId !== null ? { ...base, deviceId: { exact: choice.deviceId } } : base,
      });
    } catch (e) {
      if (choice.deviceId === null) throw e;
      // Устройство пропало между выбором и открытием — системный default.
      choice = { deviceId: null, why: `exact failed (${e instanceof Error ? e.name : "error"}) → default` };
      stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    }
    if (stale()) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    // Первый запуск без разрешения: меток не было, открылся default. Если это
    // iPhone (Continuity), а есть другой вход — переоткрываем на нём.
    const first = stream.getAudioTracks()[0];
    if (choice.deviceId === null && first && CONTINUITY_RE.test(first.label) && isDesktop()) {
      const better = await pickInput(this.badDevices);
      if (better.deviceId !== null) {
        stream.getTracks().forEach((t) => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { ...base, deviceId: { exact: better.deviceId } },
        });
        choice = { deviceId: better.deviceId, why: `default was "${first.label.slice(0, 40)}" → ${better.why}` };
        if (stale()) {
          stream.getTracks().forEach((t) => t.stop());
          return null;
        }
      }
    }
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    this.currentDeviceId = track?.getSettings().deviceId ?? choice.deviceId;
    this.soundSeen = false;
    if (webAudioBroken && recorderSupported()) {
      // Web Audio уже признан мёртвым на этой странице — сразу запасной режим.
      const label = track?.label ? track.label.slice(0, 60) : "?";
      this.startRecorder(`web audio broken earlier; device="${label}" (${choice.why})`);
      return `recorder mode; device="${label}" (${choice.why})`;
    }
    this.mode = "webaudio";
    const trackRate = track?.getSettings().sampleRate;

    let ctx = this.ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("AudioContext недоступен");
    }
    if (ctx !== null && ctx.state !== "closed") {
      await ctx.resume().catch(() => {});
      // Пересоздаём только не запустившийся контекст. Разница частот дорожки
      // и контекста — не повод: MediaStreamSource ресемплит сам, а новый
      // контекст вне жеста на iOS может остаться suspended (ревью 0.1.14).
      if (ctx.state !== "running" && isDesktop()) {
        void ctx.close().catch(() => {});
        ctx = null;
      }
    } else {
      ctx = null;
    }
    if (ctx === null) {
      ctx = new Ctor();
      await ctx.resume().catch(() => {});
    }
    this.ctx = ctx;
    if (stale()) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    const capCtx = ctx;
    capCtx.onstatechange = () => {
      if (capCtx !== this.ctx) return;
      const st = capCtx.state as string;
      this.onEvent({ kind: "state", info: `audio context ${st}` });
      if (st === "suspended" || st === "interrupted") void capCtx.resume().catch(() => {});
    };
    if (track) {
      track.onended = () => {
        if (this.stream === stream) void this.stall(gen, "mic track ended");
      };
      track.onmute = () => {
        if (this.stream === stream) this.onEvent({ kind: "state", info: "mic track muted by system" });
      };
      track.onunmute = () => {
        if (this.stream === stream) this.onEvent({ kind: "state", info: "mic track unmuted" });
      };
    }

    const emit = (f32: Float32Array): void => {
      const i16 = new Int16Array(f32.length);
      let peak = 0;
      for (let i = 0; i < f32.length; i++) {
        const x = Math.max(-1, Math.min(1, f32[i]));
        const v = Math.abs(x);
        if (v > peak) peak = v;
        i16[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
      }
      const t = performance.now();
      this.lastFrameAt = t;
      if (this.parked) {
        // Тёплый микрофон между записями: только кольцо в памяти, никуда не уходит.
        const chunk = new Uint8Array(i16.buffer);
        this.ring.push(chunk);
        this.ringBytes += chunk.byteLength;
        while (this.ringBytes > RING_MAX_BYTES && this.ring.length > 1) {
          this.ringBytes -= this.ring[0].byteLength;
          this.ring.shift();
        }
        return;
      }
      if (peak > 0) {
        this.lastSoundAt = t;
        // Звук пошёл — запоминаем устройство как рабочее (на десктопе).
        if (!this.soundSeen && peak > 0.01) {
          this.soundSeen = true;
          if (this.currentDeviceId && isDesktop()) saveLastGood(this.currentDeviceId);
        }
      }
      this.onChunk?.(new Uint8Array(i16.buffer), Math.min(1, peak * 2.2));
    };

    let node: AudioNode;
    let path = "worklet";
    try {
      if (!ctx.audioWorklet) throw new Error("AudioWorklet недоступен");
      if (preModule !== null && preCtx === ctx) {
        if (!(await preModule)) throw new Error("worklet load failed");
      } else {
        await ctx.audioWorklet.addModule(getWorkletUrl());
      }
      if (stale()) {
        stream.getTracks().forEach((t) => t.stop());
        return null;
      }
      const worklet = new AudioWorkletNode(ctx, "voice-stt-capture");
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => emit(e.data);
      node = worklet;
    } catch {
      if (stale()) {
        stream.getTracks().forEach((t) => t.stop());
        return null;
      }
      // Запасной путь (старый WebKit): ScriptProcessor + то же прореживание.
      path = "script-processor";
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const ratio = ctx.sampleRate / 16000;
      let pos = 0;
      proc.onaudioprocess = (ev: AudioProcessingEvent) => {
        const ch = ev.inputBuffer.getChannelData(0);
        const out = new Float32Array(ch.length);
        let n = 0;
        for (let i = 0; i < ch.length; i++) {
          pos += 1;
          if (pos >= ratio) {
            pos -= ratio;
            out[n++] = ch[i];
          }
        }
        if (n > 0) emit(out.subarray(0, n));
      };
      node = proc;
    }
    this.captureNode = node;
    this.source = ctx.createMediaStreamSource(stream);
    this.source.connect(node);
    node.connect(ctx.destination); // узлу захвата нужен выход, но он молчит
    const t = performance.now();
    this.lastFrameAt = t;
    this.lastSoundAt = t;
    const label = track?.label ? track.label.slice(0, 60) : "?";
    return `device="${label}" (${choice.why}) track=${trackRate ?? "?"}Hz ctx=${ctx.sampleRate}Hz state=${ctx.state} path=${path}`;
  }

  /** Новый поток + MediaRecorder без Web Audio (запасной режим). */
  private async openRecorderOnly(gen: number): Promise<string | null> {
    const choice = await pickInput(this.badDevices);
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: choice.deviceId !== null ? { ...base, deviceId: { exact: choice.deviceId } } : base,
    });
    if (gen !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    this.currentDeviceId = track?.getSettings().deviceId ?? choice.deviceId;
    const label = track?.label ? track.label.slice(0, 60) : "?";
    this.startRecorder(`web audio silent; device="${label}" (${choice.why})`);
    return "recorder";
  }

  private startRecorder(info: string): void {
    const stream = this.stream;
    if (stream === null) throw new Error("нет потока для MediaRecorder");
    this.mode = "recorder";
    this.mrMime = pickRecorderMime();
    this.mrChunks = [];
    const mr = this.mrMime !== "" ? new MediaRecorder(stream, { mimeType: this.mrMime }) : new MediaRecorder(stream);
    this.mrMime = mr.mimeType || this.mrMime || "audio/mp4";
    this.sentSamples = 0;
    this.decodeFails = 0;
    this.decodeDirty = false;
    this.decodeBusy = null;
    this.streaming = typeof OfflineAudioContext === "function";
    if (this.streaming) {
      try {
        this.decodeCtx = new OfflineAudioContext(1, 1, 16000);
      } catch {
        this.streaming = false;
      }
    }
    mr.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) {
        this.mrChunks.push(e.data);
        if (this.streaming) this.scheduleDecode(false);
      }
    };
    mr.start(this.streaming ? STREAM_SLICE_MS : 1000);
    this.mr = mr;
    this.info = `recorder ${this.mrMime}; ${info}`;
    this.lastFrameAt = performance.now();
    if (this.streaming) this.onEvent({ kind: "stream", info: this.info });
    else this.onEvent({ kind: "fallback", info: this.info });
  }

  isStreaming(): boolean {
    return this.mode === "recorder" && this.streaming && this.mr !== null;
  }

  private scheduleDecode(final: boolean): Promise<void> {
    if (this.decodeBusy !== null) {
      this.decodeDirty = true;
      return this.decodeBusy;
    }
    const run = this.decodeOnce(final).finally(() => {
      this.decodeBusy = null;
      if (this.decodeDirty && this.streaming) {
        this.decodeDirty = false;
        void this.scheduleDecode(false);
      }
    });
    this.decodeBusy = run;
    return run;
  }

  /** Раскодировать весь накопленный файл и отдать новые сэмплы (кроме хвоста). */
  private async decodeOnce(final: boolean): Promise<void> {
    const ctx = this.decodeCtx;
    if (ctx === null || this.mrChunks.length === 0) return;
    const gen = this.generation;
    try {
      const buf = await new Blob(this.mrChunks, { type: this.mrMime }).arrayBuffer();
      const audio = await ctx.decodeAudioData(buf);
      if (gen !== this.generation || !this.streaming) return;
      const ch = audio.getChannelData(0);
      // Хвост держим до следующего куска: последний кадр AAC/Opus меняется,
      // когда приходит следующий (перекрытие MDCT) — иначе щелчки на стыках.
      const upto = final ? ch.length : Math.max(this.sentSamples, ch.length - STREAM_HOLDBACK_SAMPLES);
      if (upto > this.sentSamples) {
        const fresh = ch.subarray(this.sentSamples, upto);
        this.sentSamples = upto;
        for (let i = 0; i < fresh.length; i += STREAM_EMIT_SAMPLES) {
          this.emitPcm(fresh.subarray(i, Math.min(fresh.length, i + STREAM_EMIT_SAMPLES)));
        }
      }
      this.decodeFails = 0;
    } catch (e) {
      this.decodeFails += 1;
      if (this.decodeFails >= STREAM_MAX_DECODE_FAILS && this.sentSamples === 0 && this.streaming) {
        // Раскодировать кусками не выходит — файл целиком после записи.
        this.streaming = false;
        this.onEvent({
          kind: "fallback",
          info: `${this.info}; stream decode failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  /** PCM16 из float, тот же контракт onChunk, что у worklet. */
  private emitPcm(f32: Float32Array): void {
    const i16 = new Int16Array(f32.length);
    let peak = 0;
    for (let i = 0; i < f32.length; i++) {
      const x = Math.max(-1, Math.min(1, f32[i]));
      const v = Math.abs(x);
      if (v > peak) peak = v;
      i16[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
    }
    this.lastFrameAt = performance.now();
    this.onChunk?.(new Uint8Array(i16.buffer), Math.min(1, peak * 2.2));
  }

  async flushStream(): Promise<void> {
    const mr = this.mr;
    if (mr === null || !this.streaming) return;
    // Забрать незакрытый кусок и раскодировать всё до конца, хвост включительно.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 700);
      const prev = mr.ondataavailable;
      mr.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) this.mrChunks.push(e.data);
        mr.ondataavailable = prev;
        clearTimeout(timer);
        resolve();
      };
      try {
        mr.requestData();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    if (this.decodeBusy !== null) await this.decodeBusy.catch(() => {});
    await this.decodeOnce(true);
  }

  isRecorderMode(): boolean {
    return this.mode === "recorder" && this.mr !== null;
  }

  async finishRecording(): Promise<RecordedAudio | null> {
    const mr = this.mr;
    if (mr === null) return null;
    this.mr = null;
    if (mr.state !== "inactive") {
      await new Promise<void>((resolve) => {
        mr.onstop = () => resolve();
        try {
          mr.stop();
        } catch {
          resolve();
        }
      });
    }
    const chunks = this.mrChunks;
    this.mrChunks = [];
    if (chunks.length === 0) return null;
    const blob = new Blob(chunks, { type: this.mrMime });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    const ext = this.mrMime.includes("webm") ? "webm" : this.mrMime.includes("ogg") ? "ogg" : "m4a";
    return { bytes, mimeType: this.mrMime.split(";")[0], filename: `live-dictation.${ext}` };
  }

  private streamAlive(): boolean {
    const track = this.stream?.getAudioTracks()[0];
    return this.stream !== null && this.stream.active && track !== undefined && track.readyState === "live";
  }

  /** Сторож: нет кадров / одни нули → перезапуск цепочки (до MAX_RESTARTS). */
  private armWatch(gen: number): void {
    this.clearWatch();
    this.watch = setInterval(() => {
      if (gen !== this.generation || this.restarting) return;
      const t = performance.now();
      // После перезапуска на телефоне ждём меньше — быстрее в запасной режим.
      const limit = this.restarts > 0 && !isDesktop() ? STALL_NO_FRAMES_AFTER_RESTART_MS : STALL_NO_FRAMES_MS;
      if (t - this.lastFrameAt > limit) {
        void this.stall(gen, `no audio frames ${Math.round(t - this.lastFrameAt)}ms (ctx ${this.ctx?.state ?? "none"})`);
      } else if (!this.soundSeen && t - this.lastSoundAt > STALL_ZEROS_MS) {
        // Одни нули с самого старта — устройство не даёт звука. После
        // первого звука нули — пауза в речи с шумоподавлением, не сбой.
        void this.stall(gen, `digital silence ${Math.round(t - this.lastSoundAt)}ms`);
      }
    }, WATCH_MS);
  }

  private clearWatch(): void {
    if (this.watch !== null) {
      clearInterval(this.watch);
      this.watch = null;
    }
  }

  private async stall(gen: number, reason: string): Promise<void> {
    if (gen !== this.generation || this.restarting || this.mode === "recorder") return;
    // Touch (iOS): один перезапуск со свежим AudioContext, дальше — запасной
    // режим (типовая причина — мёртвый Web Audio, смена устройства не поможет).
    // Десктоп: до MAX_RESTARTS смен устройства, потом запасной режим.
    const limit = isDesktop() ? MAX_RESTARTS : 1;
    if (this.restarts >= limit) {
      this.clearWatch();
      if (recorderSupported()) {
        this.restarting = true;
        try {
          if (!isDesktop()) webAudioBroken = true;
          this.closePipeline(true);
          this.onEvent({ kind: "stall", reason: `${reason} → MediaRecorder` });
          const info = await this.openRecorderOnly(gen);
          if (info === null) return;
        } catch (e) {
          this.onEvent({ kind: "failed", reason: `recorder fallback failed: ${e instanceof Error ? e.message : String(e)}` });
        } finally {
          this.restarting = false;
        }
        return;
      }
      this.onEvent({ kind: "failed", reason });
      return;
    }
    this.restarts += 1;
    this.restarting = true;
    // Устройство не дало звука — следующий запуск берёт другое.
    if (this.currentDeviceId) this.badDevices.add(this.currentDeviceId);
    if (this.currentDeviceId && this.currentDeviceId === loadLastGood()) {
      try {
        localStorage.removeItem(LAST_GOOD_KEY);
      } catch {
        // нет хранилища
      }
    }
    this.onEvent({ kind: "stall", reason });
    try {
      // Полный перезапуск: новый поток и новый AudioContext. На iOS контекст
      // из жеста после прерывания аудиосессии остаётся «running», но молчит —
      // переиспользовать его бесполезно (лог 07.11); пока идёт захват
      // микрофона, WebKit разрешает запуск нового контекста.
      this.closePipeline(true);
      const info = await this.open(gen);
      if (info !== null) this.onEvent({ kind: "restarted", info: `#${this.restarts} ${info}` });
    } catch (e) {
      this.onEvent({ kind: "failed", reason: `restart failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      this.restarting = false;
    }
  }

  private discardRecorder(): void {
    const mr = this.mr;
    this.mr = null;
    this.mrChunks = [];
    this.streaming = false;
    this.decodeCtx = null;
    this.decodeDirty = false;
    if (mr !== null && mr.state !== "inactive") {
      try {
        mr.ondataavailable = null;
        mr.stop();
      } catch {
        // уже остановлен
      }
    }
  }

  /** Разобрать цепочку и поток; closeCtx — закрыть и контекст. */
  private closePipeline(closeCtx: boolean): void {
    this.discardRecorder();
    try {
      this.captureNode?.disconnect();
      this.source?.disconnect();
    } catch {
      // узлы уже отсоединены
    }
    try {
      this.stream?.getTracks().forEach((t) => {
        t.onended = null;
        t.onmute = null;
        t.onunmute = null;
        t.stop();
      });
    } catch {
      // поток уже остановлен
    }
    if (closeCtx) {
      try {
        if (this.ctx) this.ctx.onstatechange = null;
        void this.ctx?.close();
      } catch {
        // контекст уже закрыт
      }
      this.ctx = null;
    }
    this.captureNode = null;
    this.source = null;
    this.stream = null;
  }

  park(ms: number): void {
    this.clearWatch();
    this.clearParkTimer();
    if (this.mode === "recorder") {
      // Запасной режим: незавершённую запись выбрасываем, поток держим тёплым.
      this.discardRecorder();
      if (ms <= 0 || !this.streamAlive()) {
        this.stop();
        return;
      }
      this.parked = true;
      this.onChunk = null;
      this.parkTimer = setTimeout(() => {
        this.parkTimer = null;
        if (this.parked) this.stop();
      }, ms);
      return;
    }
    if (ms <= 0 || !this.alive()) {
      this.stop();
      return;
    }
    this.parked = true;
    this.onChunk = null;
    this.ring = [];
    this.ringBytes = 0;
    this.parkTimer = setTimeout(() => {
      this.parkTimer = null;
      if (this.parked) this.stop();
    }, ms);
  }

  /** Цепочка жива: поток активен, дорожка live, контекст не закрыт. */
  private alive(): boolean {
    const track = this.stream?.getAudioTracks()[0];
    return (
      this.stream !== null &&
      this.stream.active &&
      track !== undefined &&
      track.readyState === "live" &&
      this.ctx !== null &&
      this.ctx.state !== "closed" &&
      this.captureNode !== null
    );
  }

  private clearParkTimer(): void {
    if (this.parkTimer !== null) {
      clearTimeout(this.parkTimer);
      this.parkTimer = null;
    }
  }

  stop(): void {
    this.generation += 1;
    this.clearParkTimer();
    this.parked = false;
    this.ring = [];
    this.ringBytes = 0;
    this.clearWatch();
    this.restarting = false;
    this.closePipeline(true);
    this.onChunk = null;
    this.mode = "webaudio";
  }
}
