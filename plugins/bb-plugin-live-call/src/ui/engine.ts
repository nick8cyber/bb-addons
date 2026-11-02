/**
 * Движок звонка в браузере: WebSocket в BB, микрофон 16 кГц, плеер 24 кГц и
 * состояние для интерфейса. Без DOM-разметки: вид рисует React (CallOverlay).
 *
 * Аудио перенесено из прежнего call-ui.ts без изменения поведения — оно
 * проверено живыми звонками: прореживание 16 кГц, один AudioContext на захват
 * и воспроизведение (опорный сигнал AEC), курсор плеера без наложений,
 * playback_drained по доигрыванию хода, обход iPhone-микрофона по умолчанию.
 * Браузер не ходит к Google: только WS в BB (ADR-0005).
 */
import { FRAME_PLAYBACK, packFrame, type ServerFrame } from "../contract.js";

const CALL_WS_PATH = "/api/v1/plugins/live-call/http/call";
const MIC_PREF_KEY = "lc-mic-id";
const FEED_LIMIT = 200;
const isIphoneMic = (label: string) => /iphone|continuity/i.test(label);

export type CallMode = "normal" | "extended";
export type OrbState =
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "working"
  | "reconnecting"
  | "muted"
  | "ended";
export type ActionStatus = "running" | "done" | "failed" | "cancelled";
export type ConfirmClass = "C" | "P" | "L";

export type FeedItem =
  | { kind: "line"; id: string; role: "owner" | "agent"; text: string; final: boolean }
  | { kind: "action"; id: string; tool: string; cls: "R" | ConfirmClass; status: ActionStatus; summary: string; threadId?: string }
  | { kind: "event"; id: string; eventKind: "thread.idle" | "thread.failed" | "interaction.pending"; threadId: string; summary: string }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string }
  | { kind: "divider"; id: string; text: string };

export interface Confirmation {
  id: string;
  cls: ConfirmClass;
  tool: string;
  summary: string;
  word: string;
  expiresAt: number;
  phase: "asking" | "listening";
}

export interface CallView {
  phase: "idle" | "connecting" | "live" | "ended" | "failed";
  orb: OrbState;
  stateDetail: string | null;
  mode: CallMode;
  switching: boolean;
  muted: boolean;
  startedAt: number | null;
  endedAt: number | null;
  callId: string | null;
  threadId: string | null;
  keys: { active: number; of: number } | null;
  feed: FeedItem[];
  confirmation: Confirmation | null;
  mics: Array<{ id: string; label: string }>;
  micId: string | null;
  micWarning: string | null;
  error: { code: string; message: string } | null;
  endReason: string | null;
  /** Растёт на каждую просьбу развернуть док (кнопка 📞 во время звонка, подтверждение). */
  expandSignal: number;
}

const IDLE: CallView = {
  phase: "idle",
  orb: "connecting",
  stateDetail: null,
  mode: "normal",
  switching: false,
  muted: false,
  startedAt: null,
  endedAt: null,
  callId: null,
  threadId: null,
  keys: null,
  feed: [],
  confirmation: null,
  mics: [],
  micId: null,
  micWarning: null,
  error: null,
  endReason: null,
  expandSignal: 0,
};

const WORKLET_SOURCE = `
class LiveCallCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // Прореживание input rate -> 16 кГц: один выходной сэмпл на каждые ratio входных.
    this.ratio = sampleRate / 16000;
    this.buffer = new Float32Array(2048);
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
registerProcessor("live-call-capture", LiveCallCapture);
`;

/**
 * Плеер: один курсор воспроизведения — каждый кусок начинается строго после
 * предыдущего, ходы не накладываются. playback_drained уходит, когда ход доигран.
 */
class TurnPlayer {
  private pending: Array<{ turnSeq: number; buffer: AudioBuffer }> = [];
  private sources: Array<{ turnSeq: number; source: AudioBufferSourceNode }> = [];
  private lastTurnSeq: number | null = null;
  private drainedSent = new Set<number>();
  private nextStart = 0;

  constructor(
    private ctx: AudioContext,
    private drained: (turnSeq: number) => void,
  ) {}

  enqueue(turnSeq: number, pcm: Uint8Array) {
    if (pcm.length === 0) {
      this.maybeDrain(turnSeq);
      return;
    }
    this.lastTurnSeq = turnSeq;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
    if (samples.length === 0) return;
    const buffer = this.ctx.createBuffer(1, samples.length, 24000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) data[i] = samples[i] / 32768;
    this.pending.push({ turnSeq, buffer });
    this.schedule();
  }

  private schedule() {
    while (this.pending.length > 0) {
      const item = this.pending.shift()!;
      const source = this.ctx.createBufferSource();
      source.buffer = item.buffer;
      source.connect(this.ctx.destination);
      const start = Math.max(this.ctx.currentTime + 0.015, this.nextStart);
      this.nextStart = start + item.buffer.duration;
      source.onended = () => {
        this.sources = this.sources.filter((p) => p.source !== source);
        if (this.lastTurnSeq !== null) this.maybeDrain(this.lastTurnSeq);
      };
      this.sources.push({ turnSeq: item.turnSeq, source });
      source.start(start);
    }
  }

  private maybeDrain(turnSeq: number) {
    if (this.pending.length > 0 || this.sources.length > 0) return;
    if (this.drainedSent.has(turnSeq)) return;
    this.drainedSent.add(turnSeq);
    this.drained(turnSeq);
  }

  interrupted() {
    for (const p of this.sources) {
      try {
        p.source.stop();
      } catch {
        // источник уже закончился
      }
    }
    this.sources = [];
    this.pending = [];
    this.nextStart = this.ctx.currentTime;
    this.drainedSent.clear();
  }
}

type Listener = () => void;

/** Уровень микрофона отдельно: обновляется ~10 раз в секунду и не перерисовывает весь док. */
class LevelStore {
  private value = 0;
  private listeners = new Set<Listener>();
  private lastEmit = 0;
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = () => this.value;
  set(v: number) {
    const now = performance.now();
    if (now - this.lastEmit < 90 && Math.abs(v - this.value) < 0.15) return;
    this.lastEmit = now;
    this.value = v;
    for (const fn of this.listeners) fn();
  }
}

export class CallEngine {
  private view: CallView = IDLE;
  private listeners = new Set<Listener>();
  readonly level = new LevelStore();

  private sock: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private player: TurnPlayer | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private seq = 0;
  private ownerHeard = false;

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.view;

  private patch(next: Partial<CallView>) {
    this.view = { ...this.view, ...next };
    for (const fn of this.listeners) fn();
  }

  private push(item: FeedItem) {
    const feed = [...this.view.feed, item];
    this.patch({ feed: feed.length > FEED_LIMIT ? feed.slice(feed.length - FEED_LIMIT) : feed });
  }

  private nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private send(frame: object) {
    if (this.sock?.readyState === WebSocket.OPEN) this.sock.send(JSON.stringify(frame));
  }

  isActive() {
    return this.view.phase === "connecting" || this.view.phase === "live";
  }

  requestExpand() {
    this.patch({ expandSignal: this.view.expandSignal + 1 });
  }

  start(mode?: CallMode) {
    if (this.isActive()) {
      this.requestExpand();
      return;
    }
    this.releaseAudio();
    this.ownerHeard = false;
    this.view = { ...IDLE, phase: "connecting", orb: "connecting", expandSignal: this.view.expandSignal + 1 };
    this.patch({});
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${wsProto}//${location.host}${CALL_WS_PATH}`);
    sock.binaryType = "arraybuffer";
    this.sock = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: "hello", protocol: 1, ...(mode ? { mode } : {}) }));
    sock.onmessage = (ev: MessageEvent) => void this.onMessage(ev);
    sock.onerror = () => {
      if (this.view.phase === "connecting") {
        this.patch({ error: { code: "connect", message: "Не удалось подключиться к серверу звонка" } });
      }
    };
    sock.onclose = () => {
      if (this.sock !== sock) return;
      this.sock = null;
      this.releaseAudio();
      if (this.view.phase === "connecting") {
        this.patch({
          phase: "failed",
          orb: "ended",
          error: this.view.error ?? { code: "connect", message: "Соединение со звонком закрылось до начала" },
        });
      } else if (this.view.phase === "live") {
        this.patch({ phase: "ended", orb: "ended", endedAt: Date.now(), endReason: this.view.endReason ?? "connection", confirmation: null });
      }
    };
  }

  end() {
    if (this.sock?.readyState === WebSocket.OPEN) this.send({ type: "end" });
    else if (this.view.phase === "connecting") {
      this.sock?.close();
      this.dismiss();
    }
  }

  dismiss() {
    this.sock?.close();
    this.sock = null;
    this.releaseAudio();
    this.view = { ...IDLE, expandSignal: this.view.expandSignal };
    this.patch({});
  }

  toggleMute() {
    const muted = !this.view.muted;
    this.patch({ muted, orb: muted ? "muted" : "listening" });
    this.send({ type: "mute", muted });
  }

  switchMode(mode: CallMode) {
    if (mode === this.view.mode || this.view.switching || this.view.confirmation) return;
    this.patch({ switching: true });
    this.send({ type: "switch_mode", mode });
  }

  toggleMode() {
    this.switchMode(this.view.mode === "normal" ? "extended" : "normal");
  }

  confirm(id: string) {
    this.send({ type: "confirm", confirmationId: id, decision: "approve" });
  }

  cancel(id: string) {
    this.send({ type: "confirm", confirmationId: id, decision: "cancel" });
  }

  async selectMic(deviceId: string) {
    if (!this.ctx || !this.worklet || !deviceId) return;
    try {
      localStorage.setItem(MIC_PREF_KEY, deviceId);
      const next = await navigator.mediaDevices.getUserMedia({ audio: { ...this.micBase(), deviceId: { exact: deviceId } } });
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = next;
      this.source?.disconnect();
      this.source = this.ctx.createMediaStreamSource(next);
      this.source.connect(this.worklet);
      this.patch({ micId: deviceId, micWarning: null });
    } catch (e) {
      this.patch({ micWarning: `Не удалось переключить микрофон: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private micBase(): MediaTrackConstraints {
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  }

  private releaseAudio() {
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch {
      // поток уже остановлен
    }
    try {
      void this.ctx?.close();
    } catch {
      // контекст уже закрыт
    }
    void this.wakeLock?.release().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.worklet = null;
    this.source = null;
    this.player = null;
    this.wakeLock = null;
    this.level.set(0);
  }

  private async onMessage(ev: MessageEvent) {
    if (ev.data instanceof ArrayBuffer) {
      const view = new Uint8Array(ev.data);
      if (view[0] !== FRAME_PLAYBACK || view.length < 5) return;
      const turnSeq = new DataView(ev.data).getUint32(1, true);
      this.player?.enqueue(turnSeq, view.slice(5));
      return;
    }
    let frame: ServerFrame;
    try {
      frame = JSON.parse(String(ev.data)) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case "ready":
        this.patch({
          phase: "live",
          orb: "listening",
          mode: frame.mode,
          callId: frame.callId,
          keys: frame.keys,
          startedAt: Date.now(),
        });
        await this.startAudio();
        break;
      case "thread":
        this.patch({ threadId: frame.threadId });
        break;
      case "state":
        if (frame.state === "ended") this.patch({ orb: "ended" });
        else this.patch({ orb: this.view.muted ? "muted" : frame.state, stateDetail: frame.detail ?? null });
        break;
      case "transcript":
        this.onTranscript(frame.role, frame.text, frame.final);
        break;
      case "interrupted":
        this.player?.interrupted();
        break;
      case "action": {
        const feed = this.view.feed;
        const idx = feed.findIndex((f) => f.kind === "action" && f.id === frame.actionId);
        const item: FeedItem = {
          kind: "action",
          id: frame.actionId,
          tool: frame.tool,
          cls: frame.class,
          status: frame.status,
          summary: frame.summary,
          threadId: frame.threadId ?? (idx >= 0 ? (feed[idx] as { threadId?: string }).threadId : undefined),
        };
        if (idx >= 0) this.patch({ feed: [...feed.slice(0, idx), item, ...feed.slice(idx + 1)] });
        else this.push(item);
        break;
      }
      case "confirmation":
        this.patch({
          confirmation: {
            id: frame.confirmationId,
            cls: frame.class,
            tool: frame.tool,
            summary: frame.summary,
            word: frame.word,
            expiresAt: Date.parse(frame.expiresAt),
            phase: frame.phase,
          },
          expandSignal: this.view.expandSignal + 1,
        });
        break;
      case "confirmation_result": {
        if (this.view.confirmation?.id !== frame.confirmationId) break;
        if (frame.verdict === "hint") {
          this.patch({ confirmation: { ...this.view.confirmation, phase: "asking" } });
          break;
        }
        this.patch({ confirmation: null });
        if (frame.verdict === "expired") this.push({ kind: "notice", id: this.nextId("n"), tone: "info", text: "Не дождался ответа — отменил" });
        else if (frame.verdict === "cancelled" || frame.verdict === "not_confirmed") {
          this.push({ kind: "notice", id: this.nextId("n"), tone: "info", text: "Действие отменено" });
        }
        break;
      }
      case "event":
        this.push({ kind: "event", id: this.nextId("e"), eventKind: frame.kind, threadId: frame.threadId, summary: frame.summary });
        break;
      case "mode": {
        const wasSwitching = this.view.switching;
        this.patch({ mode: frame.mode, switching: frame.switching });
        if (wasSwitching && !frame.switching) {
          this.push({ kind: "divider", id: this.nextId("d"), text: `${frame.mode === "extended" ? "Extended" : "Обычный"} с ${this.elapsedLabel()}` });
        }
        break;
      }
      case "key":
        this.patch({ keys: { active: frame.active, of: frame.of } });
        this.push({
          kind: "notice",
          id: this.nextId("n"),
          tone: "warn",
          text: frame.reason === "quota" ? "Основной ключ упёрся в лимит — перешёл на запасной" : "Основной ключ недоступен — перешёл на запасной",
        });
        break;
      case "warning":
        this.push({ kind: "notice", id: this.nextId("n"), tone: "warn", text: frame.message });
        break;
      case "error":
        if (this.view.phase === "connecting") this.patch({ error: { code: frame.code, message: frame.message } });
        else this.push({ kind: "notice", id: this.nextId("n"), tone: "error", text: frame.message });
        if (frame.code === "pending_confirmation") this.patch({ switching: false });
        break;
      case "ended":
        this.patch({
          phase: "ended",
          orb: "ended",
          endedAt: Date.now(),
          endReason: frame.reason,
          threadId: frame.threadId ?? this.view.threadId,
          confirmation: null,
        });
        this.releaseAudio();
        break;
      default:
        break;
    }
  }

  private elapsedLabel() {
    const s = this.view.startedAt ? Math.max(0, Math.floor((Date.now() - this.view.startedAt) / 1000)) : 0;
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  /** Одна реплика — одна строка: куски дописываются, финал перезаписывает ту же строку. */
  private onTranscript(role: "owner" | "agent", text: string, final: boolean) {
    if (role === "owner" && final) this.ownerHeard = true;
    const feed = this.view.feed;
    const last = feed[feed.length - 1];
    if (last && last.kind === "line" && last.role === role && !last.final) {
      const merged: FeedItem = { ...last, text: final ? text : last.text + text, final };
      this.patch({ feed: [...feed.slice(0, -1), merged] });
      return;
    }
    if (!text.trim() && !final) return;
    this.push({ kind: "line", id: this.nextId("l"), role, text, final });
  }

  private async startAudio() {
    const sock = this.sock;
    if (!sock) return;
    try {
      const savedMic = localStorage.getItem(MIC_PREF_KEY) ?? "";
      const base = this.micBase();
      let stream = await navigator.mediaDevices.getUserMedia({ audio: savedMic ? { ...base, deviceId: { exact: savedMic } } : base }).catch(
        // Сохранённого устройства больше нет — берём системное.
        () => navigator.mediaDevices.getUserMedia({ audio: base }),
      );
      if (!savedMic && isIphoneMic(stream.getAudioTracks()[0]?.label ?? "")) {
        // macOS с Continuity делает iPhone микрофоном по умолчанию.
        const devices = await navigator.mediaDevices.enumerateDevices();
        const better = devices.find((d) => d.kind === "audioinput" && !isIphoneMic(d.label));
        if (better) {
          stream.getTracks().forEach((t) => t.stop());
          stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: better.deviceId } } });
          this.patch({ micWarning: `Микрофон по умолчанию — iPhone, взял «${better.label.slice(0, 40)}»` });
        }
      }
      if (this.sock !== sock) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = stream.getAudioTracks()[0];
      const micId = track?.getSettings().deviceId ?? "";
      localStorage.setItem(MIC_PREF_KEY, micId);
      this.stream = stream;
      const ctx = new AudioContext();
      this.ctx = ctx;
      await ctx.resume();
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" })));
      const worklet = new AudioWorkletNode(ctx, "live-call-capture");
      this.worklet = worklet;
      let silentChunks = 0;
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (sock.readyState !== WebSocket.OPEN) return;
        const f32 = e.data;
        const i16 = new Int16Array(f32.length);
        let peak = 0;
        for (let i = 0; i < f32.length; i++) {
          const x = Math.max(-1, Math.min(1, f32[i]));
          const v = Math.abs(x);
          if (v > peak) peak = v;
          i16[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
        }
        this.level.set(this.view.muted ? 0 : Math.min(1, peak * 2.2));
        if (peak > 0.01) {
          silentChunks = 0;
          if (this.ownerHeard && this.view.micWarning?.startsWith("Микрофон молчит")) this.patch({ micWarning: null });
        } else {
          silentChunks += 1;
          if (silentChunks === 25 && !this.ownerHeard) {
            this.patch({ micWarning: "Микрофон молчит — проверь, не выключен ли он в системе или браузере" });
            this.send({ type: "client_log", event: "mic_silent", detail: "peak=0 около 3 c" });
          }
        }
        sock.send(packFrame(0x01, 0, new Uint8Array(i16.buffer)));
      };
      this.source = ctx.createMediaStreamSource(stream);
      this.source.connect(worklet);
      worklet.connect(ctx.destination); // worklet требует выхода, но молчит
      // Плеер на ТОМ ЖЕ контексте, что и захват: голос агента — опорный сигнал AEC.
      this.player = new TurnPlayer(ctx, (turnSeq) => this.send({ type: "playback_drained", turnSeq }));
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Микрофон ${i + 1}` }));
      this.patch({ mics, micId });
      const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
      this.wakeLock = (await nav.wakeLock?.request("screen").catch(() => null)) ?? null;
    } catch (e) {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const denied = e instanceof Error && (e.name === "NotAllowedError" || e.name === "SecurityError");
      this.patch({
        micWarning: denied
          ? "Браузер не дал доступ к микрофону: нажми на замок в адресной строке → Микрофон → Разрешить"
          : `Микрофон недоступен: ${message}`,
      });
      this.send({ type: "client_log", event: "mic_error", detail: message.slice(0, 200) });
    }
  }
}

export const callEngine = new CallEngine();
