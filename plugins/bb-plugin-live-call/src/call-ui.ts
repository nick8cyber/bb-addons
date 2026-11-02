/**
 * Оверлей звонка: прямой DOM поверх document.body (по образцу SpeakOverlay).
 * Микрофон — AudioWorklet 16 кГц в бинарные кадры WS; плеер — очередь 24 кГц
 * с мгновенным сбросом по interrupted и playback_drained по доигрывании хода.
 * Браузер не ходит к Google: только WS в BB (ADR-0005).
 */
import { FRAME_PLAYBACK, packFrame, type ServerFrame } from "./contract.js";

const CALL_WS_PATH = "/api/v1/plugins/live-call/http/call";
const OVERLAY_ID = "bb-live-call-overlay";
const BUTTON_ID = "bb-live-call-button";

export function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const WORKLET_SOURCE = `
class LiveCallCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // Целевая частота 16 кГц; sampleRate глобален в worklet-реалме.
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
      this.pos += this.ratio;
      while (this.pos >= 1 && this.filled < this.buffer.length) {
        this.pos -= 1;
        this.buffer[this.filled++] = ch[i];
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

type CallUi = {
  sock: WebSocket;
  audioCtxOut: AudioContext;
  stream: MediaStream;
  audioCtxIn: AudioContext;
  setStateLine: (s: string) => void;
  addTranscript: (role: "owner" | "agent", text: string) => void;
};

/** Плеер: очередь источников по ходам; drained — когда ход доигран и новых кусков нет. */
class TurnPlayer {
  private pending: Array<{ turnSeq: number; buffer: AudioBuffer }> = [];
  private playing: Array<{ turnSeq: number; source: AudioBufferSourceNode }> = [];
  private drainedSent = new Set<number>();
  private openTurn: number | null = null;

  constructor(private ctx: AudioContext, private drained: (turnSeq: number) => void) {}

  enqueue(turnSeq: number, pcm: Uint8Array) {
    if (pcm.length === 0) {
      this.maybeDrain(turnSeq, true);
      return;
    }
    if (this.openTurn === null) this.openTurn = turnSeq;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
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
      const turnSeq = item.turnSeq;
      source.onended = () => {
        this.playing = this.playing.filter((p) => p.source !== source);
        this.maybeDrain(turnSeq, false);
      };
      const delay = this.playing.reduce((max, p) => Math.max(max, (p.source.buffer?.duration ?? 0)), 0);
      source.start(this.ctx.currentTime + 0.02 + (this.playing.length > 0 ? delay : 0));
      this.playing.push({ turnSeq, source });
    }
  }

  private maybeDrain(turnSeq: number, immediate: boolean) {
    if (this.pending.length > 0) return;
    if (this.playing.some((p) => p.turnSeq === turnSeq)) return;
    if (this.drainedSent.has(turnSeq)) return;
    this.drainedSent.add(turnSeq);
    if (immediate || this.playing.length === 0) this.drained(turnSeq);
  }

  interrupted() {
    for (const p of this.playing) {
      try {
        p.source.stop();
      } catch {
        // Источник уже остановился.
      }
    }
    this.playing = [];
    this.pending = [];
    this.openTurn = null;
  }
}

export async function startCall(mode?: "normal" | "extended"): Promise<void> {
  if (document.getElementById(OVERLAY_ID)) return;
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${wsProto}//${location.host}${CALL_WS_PATH}`);
  sock.binaryType = "arraybuffer";

  const overlay = buildOverlay();
  const ui: Partial<CallUi> = { sock };
  let player: TurnPlayer | null = null;
  let audioCtxOut: AudioContext | null = null;

  const teardown = () => {
    try {
      (ui.stream as MediaStream | undefined)?.getTracks().forEach((t) => t.stop());
    } catch {
      // поток уже остановлен
    }
    try {
      audioCtxOut?.close();
      ui.audioCtxIn?.close();
    } catch {
      // контексты уже закрыты
    }
    overlay.root.remove();
    overlay.button.style.display = "";
  };

  sock.onopen = () => {
    sock.send(JSON.stringify({ type: "hello", protocol: 1, mode }));
  };
  sock.onclose = () => teardown();
  sock.onerror = () => overlay.stateLine.textContent = "Ошибка соединения";

  sock.onmessage = async (ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) {
      const view = new Uint8Array(ev.data);
      if (view[0] !== FRAME_PLAYBACK) return;
      const turnSeq = new DataView(ev.data).getUint32(1, true);
      const pcm = view.slice(5);
      player?.enqueue(turnSeq, pcm);
      return;
    }
    let frame: ServerFrame;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    switch (frame.type) {
      case "ready": {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        ui.stream = stream;
        const ctxIn = new AudioContext();
        ui.audioCtxIn = ctxIn;
        // Браузер создаёт контексты suspended, даже после клика — без resume микрофон молчит.
        await ctxIn.resume();
        await ctxIn.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" })));
        const source = ctxIn.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(ctxIn, "live-call-capture");
        worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
          if (sock.readyState !== WebSocket.OPEN) return;
          const f32 = e.data;
          const i16 = new Int16Array(f32.length);
          for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          sock.send(packFrame(0x01, 0, new Uint8Array(i16.buffer)));
        };
        source.connect(worklet);
        worklet.connect(ctxIn.destination); // worklet требует выхода, но молчит
        audioCtxOut = new AudioContext({ sampleRate: 24000 });
        await audioCtxOut.resume();
        player = new TurnPlayer(audioCtxOut, (turnSeq) => {
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "playback_drained", turnSeq }));
        });
        ui.audioCtxOut = audioCtxOut;
        overlay.stateLine.textContent = "Готов: говорите";
        break;
      }
      case "thread":
        overlay.threadLine.textContent = "Записывается в тред звонка";
        break;
      case "state":
        overlay.stateLine.textContent = stateLabel(frame.state, frame.detail);
        break;
      case "transcript":
        overlay.addTranscript(frame.role, frame.text);
        break;
      case "interrupted":
        player?.interrupted();
        break;
      case "confirmation": {
        overlay.showConfirmation(frame.confirmationId, frame.summary, frame.word, frame.phase === "listening");
        break;
      }
      case "confirmation_result":
        overlay.hideConfirmation(frame.verdict);
        break;
      case "action":
        overlay.addAction(frame.status === "done" ? "✅" : frame.status === "failed" ? "⚠️" : "⏳", frame.summary);
        break;
      case "mode":
        overlay.modeLine.textContent = frame.switching ? "Переключаюсь…" : frame.mode === "extended" ? "🧠 Extended" : "⚡ Обычный";
        break;
      case "warning":
        overlay.addAction("⚠️", frame.message);
        break;
      case "error":
        overlay.addAction("⚠️", `Ошибка (${frame.code}): ${frame.message}`);
        break;
      case "ended":
        overlay.addAction("📞", "Звонок завершён");
        setTimeout(teardown, 1500);
        break;
      default:
        break;
    }
  };

  overlay.setHandlers({
    confirm: (id) => sock.send(JSON.stringify({ type: "confirm", confirmationId: id, decision: "approve" })),
    cancel: (id) => sock.send(JSON.stringify({ type: "confirm", confirmationId: id, decision: "cancel" })),
    mute: (muted) => sock.send(JSON.stringify({ type: "mute", muted })),
    switchMode: (mode) => sock.send(JSON.stringify({ type: "switch_mode", mode })),
    end: () => sock.send(JSON.stringify({ type: "end" })),
  });
}

function stateLabel(state: string, detail?: string): string {
  const map: Record<string, string> = {
    connecting: "Соединяюсь…",
    listening: "Слушаю",
    thinking: "Думаю",
    speaking: "Говорю",
    working: "Делаю",
    reconnecting: `Переподключаюсь${detail ? ` (${detail})` : ""}`,
    muted: "Микрофон выключен",
    ended: "Завершено",
  };
  return map[state] ?? state;
}

function buildOverlay() {
  const button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (button) button.style.display = "none";

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.style.cssText = `
    position: fixed; right: 24px; bottom: 24px; z-index: 999999;
    width: 360px; max-height: 70vh; display: flex; flex-direction: column;
    background: var(--color-canvas, #16171a); color: var(--color-ink, #e8e8ea);
    border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,.4); font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px; overflow: hidden; pointer-events: auto;
  `;
  const header = document.createElement("div");
  header.style.cssText = "padding:10px 12px; display:flex; align-items:center; gap:8px; border-bottom:1px solid rgba(255,255,255,.1); font-weight:600;";
  header.innerHTML = `📞 Звонок <span id="lc-mode" style="opacity:.6;font-weight:400"></span>
    <span id="lc-state" style="margin-left:auto;opacity:.7;font-weight:400"></span>`;
  const modeLine = header.querySelector("#lc-mode") as HTMLElement;
  const stateLine = header.querySelector("#lc-state") as HTMLElement;

  const threadLine = document.createElement("div");
  threadLine.style.cssText = "padding:4px 12px; opacity:.5; font-size:11px;";

  const log = document.createElement("div");
  log.style.cssText = "flex:1; overflow-y:auto; padding:8px 12px; display:flex; flex-direction:column; gap:6px; min-height:120px;";

  const confirmation = document.createElement("div");
  confirmation.style.cssText = "display:none; padding:10px 12px; margin:0 8px 8px; border:1px solid rgba(255,180,80,.4); border-radius:10px; background:rgba(255,180,80,.08);";

  const controls = document.createElement("div");
  controls.style.cssText = "display:flex; gap:8px; padding:10px 12px; border-top:1px solid rgba(255,255,255,.1);";
  const mkBtn = (label: string, title: string) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.style.cssText = "flex:1; padding:8px 6px; border-radius:8px; border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.06); color:inherit; cursor:pointer; font-size:12px;";
    return b;
  };
  const muteBtn = mkBtn("🎙 Микрофон", "Приглушить/вернуть микрофон");
  const modeBtn = mkBtn("🧠 Extended", "Переключить режим");
  const endBtn = mkBtn("■ Завершить", "Завершить звонок");
  endBtn.style.borderColor = "rgba(255,100,100,.4)";
  controls.append(muteBtn, modeBtn, endBtn);
  root.append(header, threadLine, log, confirmation, controls);
  document.body.append(root);

  let muted = false;
  let currentConfirmationId: string | null = null;
  let handlers: {
    confirm(id: string): void;
    cancel(id: string): void;
    mute(muted: boolean): void;
    switchMode(mode: "normal" | "extended"): void;
    end(): void;
  } | null = null;

  muteBtn.onclick = () => {
    muted = !muted;
    muteBtn.textContent = muted ? "🎙 Выкл" : "🎙 Микрофон";
    handlers?.mute(muted);
  };
  modeBtn.onclick = () => {
    handlers?.switchMode(modeBtn.textContent?.includes("Extended") ? "normal" : "extended");
  };
  endBtn.onclick = () => handlers?.end();

  return {
    root,
    button: button as HTMLButtonElement,
    modeLine,
    stateLine,
    threadLine,
    addTranscript(role: "owner" | "agent", text: string) {
      const row = document.createElement("div");
      row.style.cssText = `white-space:pre-wrap; ${role === "agent" ? "opacity:.92" : "opacity:.6;"}`;
      row.textContent = `${role === "agent" ? "Агент: " : "Вы: "}${text}`;
      log.append(row);
      log.scrollTop = log.scrollHeight;
    },
    addAction(icon: string, text: string) {
      const row = document.createElement("div");
      row.style.cssText = "opacity:.7; font-size:12px;";
      row.textContent = `${icon} ${text}`;
      log.append(row);
      log.scrollTop = log.scrollHeight;
    },
    showConfirmation(id: string, summary: string, word: string, listening: boolean) {
      currentConfirmationId = id;
      confirmation.style.display = "block";
      confirmation.innerHTML = `
        <div style="margin-bottom:8px;">${esc(summary)}</div>
        <div style="opacity:.6;margin-bottom:8px;font-size:11px;">Скажите «${esc(word)}» или нажмите:${listening ? "" : " (вопрос ещё звучит)"}</div>`;
      const yes = document.createElement("button");
      yes.textContent = "Подтвердить";
      yes.style.cssText = "padding:6px 12px; margin-right:8px; border-radius:8px; border:1px solid rgba(120,255,120,.4); background:rgba(120,255,120,.1); color:inherit; cursor:pointer;";
      const no = document.createElement("button");
      no.textContent = "Отмена";
      no.style.cssText = "padding:6px 12px; border-radius:8px; border:1px solid rgba(255,120,120,.4); background:rgba(255,120,120,.1); color:inherit; cursor:pointer;";
      yes.onclick = () => handlers?.confirm(id);
      no.onclick = () => handlers?.cancel(id);
      confirmation.append(yes, no);
    },
    hideConfirmation(verdict: string) {
      confirmation.style.display = "none";
      currentConfirmationId = null;
      void verdict;
    },
    setHandlers(h: typeof handlers) {
      handlers = h;
    },
  };
}

/** Кнопка 📞 в углу: вход в звонок без привязки к треду (спека §6). */
export function mountCallButton(): () => void {
  if (typeof document === "undefined") return () => {};
  const existing = document.getElementById(BUTTON_ID);
  if (existing) existing.remove();
  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.title = "Позвонить координатору (живой голос)";
  btn.textContent = "📞";
  btn.style.cssText = `
    position: fixed; right: 24px; bottom: 24px; z-index: 999998;
    width: 44px; height: 44px; border-radius: 50%; border: 1px solid rgba(255,255,255,.15);
    background: var(--color-primary, #4f6ef7); color: #fff; font-size: 20px; cursor: pointer;
    box-shadow: 0 6px 20px rgba(0,0,0,.35); pointer-events: auto;
  `;
  btn.onclick = () => void startCall();
  document.body.append(btn);
  return () => btn.remove();
}
