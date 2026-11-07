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
    this.buffer = new Float32Array(1600);
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
  | { kind: "failed"; reason: string };

export interface MicCaptureLike {
  /** Синхронно создать и разбудить AudioContext — вызывать из pointer-обработчика. */
  unlock(): void;
  /** Поднять getUserMedia + цепочку захвата; чанки идут в onChunk. */
  start(
    onChunk: (pcm: Uint8Array, level: number) => void,
    onEvent?: (ev: CaptureEvent) => void,
  ): Promise<void>;
  stop(): void;
}

/** Нет ни одного кадра дольше — захват встал (контекст/устройство). */
const STALL_NO_FRAMES_MS = 1500;
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
    this.onChunk = onChunk;
    this.onEvent = onEvent ?? (() => {});
    this.restarts = 0;
    this.badDevices = new Set();
    const gen = this.generation;
    const info = await this.open(gen);
    if (info === null) return;
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
      await ctx.audioWorklet.addModule(
        URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" })),
      );
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

  /** Сторож: нет кадров / одни нули → перезапуск цепочки (до MAX_RESTARTS). */
  private armWatch(gen: number): void {
    this.clearWatch();
    this.watch = setInterval(() => {
      if (gen !== this.generation || this.restarting) return;
      const t = performance.now();
      if (t - this.lastFrameAt > STALL_NO_FRAMES_MS) {
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
    if (gen !== this.generation || this.restarting) return;
    if (this.restarts >= MAX_RESTARTS) {
      this.clearWatch();
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
      // Десктоп — полный перезапуск (новое устройство, новый контекст);
      // touch/iOS — контекст из жеста сохраняем, пересоздаём только поток.
      this.closePipeline(isDesktop());
      const info = await this.open(gen);
      if (info !== null) this.onEvent({ kind: "restarted", info: `#${this.restarts} ${info}` });
    } catch (e) {
      this.onEvent({ kind: "failed", reason: `restart failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      this.restarting = false;
    }
  }

  /** Разобрать цепочку и поток; closeCtx — закрыть и контекст. */
  private closePipeline(closeCtx: boolean): void {
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

  stop(): void {
    this.generation += 1;
    this.clearWatch();
    this.restarting = false;
    this.closePipeline(true);
    this.onChunk = null;
  }
}
