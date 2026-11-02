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
const MIC_PREF_KEY = "lc-mic-id";
const isIphoneMic = (label: string) => /iphone|continuity/i.test(label);

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
    // Прореживание input rate -> 16 кГц: один выходной сэмпл на каждые ratio входных.
    // Раньше цикл был навыворот и КОПИРОВАЛ каждый сэмпл ratio раз — Gemini получал
    // голос, ускоренный в 3 раза, и не распознавал ни слова (инцидент 02.11).
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

type CallUi = {
  sock: WebSocket;
  audioCtxOut: AudioContext;
  stream: MediaStream;
  audioCtxIn: AudioContext;
  setStateLine: (s: string) => void;
  addTranscript: (role: "owner" | "agent", text: string) => void;
};

/**
 * Плеер: один курсор воспроизведения — каждый следующий кусок начинается строго
 * после предыдущего, ходы не накладываются (инцидент 02.11: сегменты одного ответа
 * играли одновременно). playback_drained уходит, когда весь ход доигран.
 */
class TurnPlayer {
  private pending: Array<{ turnSeq: number; buffer: AudioBuffer }> = [];
  private sources: Array<{ turnSeq: number; source: AudioBufferSourceNode }> = [];
  private lastTurnSeq: number | null = null;
  private drainedSent = new Set<number>();
  private nextStart = 0;

  constructor(private ctx: AudioContext, private drained: (turnSeq: number) => void) {}

  enqueue(turnSeq: number, pcm: Uint8Array) {
    if (pcm.length === 0) {
      this.maybeDrain(turnSeq);
      return;
    }
    this.lastTurnSeq = turnSeq;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
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
      // Курсор: куски встык (любая пауза = щелчок на склейке), без зазоров.
      const start = Math.max(this.ctx.currentTime + 0.015, this.nextStart);
      this.nextStart = start + item.buffer.duration;
      const turnSeq = item.turnSeq;
      source.onended = () => {
        this.sources = this.sources.filter((p) => p.source !== source);
        if (this.lastTurnSeq !== null) this.maybeDrain(this.lastTurnSeq);
      };
      this.sources.push({ turnSeq, source });
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
    // ПЕРЕБИВАНИЕ: старая речь обязана замолчать — иначе она звучит поверх новой.
    for (const p of this.sources) {
      try {
        p.source.stop();
      } catch {
        // Источник уже закончился.
      }
    }
    this.sources = [];
    this.pending = [];
    this.nextStart = this.ctx.currentTime;
    this.drainedSent.clear();
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
  let ownerHeard = false;
  let currentMode: "normal" | "extended" = "normal";

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
        currentMode = frame.mode;
        try {
          // macOS с Continuity делает iPhone микрофоном по умолчанию — браузер берёт
          // системный дефолт и получает телефон. Обходим: сохранённый выбор владельца,
          // иначе — первое не-iPhone устройство (репорт владельца 02.11).
          const savedMic = localStorage.getItem(MIC_PREF_KEY) ?? "";
          const base: MediaTrackConstraints = {
            echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
          };
          let stream = await navigator.mediaDevices.getUserMedia({
            audio: savedMic ? { ...base, deviceId: { exact: savedMic } } : base,
          });
          if (!savedMic && isIphoneMic(stream.getAudioTracks()[0]?.label ?? "")) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const better = devices.find((d) => d.kind === "audioinput" && !isIphoneMic(d.label));
            if (better) {
              stream.getTracks().forEach((t) => t.stop());
              stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: better.deviceId } } });
              overlay.micWarning.textContent = `Микрофон по умолчанию — iPhone, взял «${better.label.slice(0, 40)}». Сменить — селектор под статусом`;
            }
          }
          const track = stream.getAudioTracks()[0];
          localStorage.setItem(MIC_PREF_KEY, track?.getSettings().deviceId ?? "");
          ui.stream = stream;
          const ctxIn = new AudioContext();
          ui.audioCtxIn = ctxIn;
          // Браузер создаёт контексты suspended, даже после клика — без resume микрофон молчит.
          await ctxIn.resume();
          await ctxIn.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" })));
          const sourceRef: { source: MediaStreamAudioSourceNode } = { source: null as unknown as MediaStreamAudioSourceNode };
          const worklet = new AudioWorkletNode(ctxIn, "live-call-capture");
          let silentSeconds = 0;
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
            overlay.setOrbLevel(peak * 2.2);
            // Диагностика: предупреждение только пока владелец ещё ни разу не был услышан —
            // после паузы оно лишь путает (инцидент 02.11).
            if (peak > 0.01) {
              silentSeconds = 0;
              if (ownerHeard && overlay.micWarning) overlay.micWarning.textContent = "";
            } else {
              silentSeconds += 1;
              if (silentSeconds === 25 && !ownerHeard) { // ≈3 с тишины до первой реплики
                overlay.micWarning.textContent = "⚠ Микрофон молчит: проверь, не замучен ли он в системе/браузере";
                sock.send(JSON.stringify({ type: "client_log", event: "mic_silent", detail: "peak=0 около 3 c" }));
              }
            }
            sock.send(packFrame(0x01, 0, new Uint8Array(i16.buffer)));
          };
          sourceRef.source = ctxIn.createMediaStreamSource(stream);
          sourceRef.source.connect(worklet);
          worklet.connect(ctxIn.destination); // worklet требует выхода, но молчит
          audioCtxOut = new AudioContext({ sampleRate: 24000 });
          await audioCtxOut.resume();
          player = new TurnPlayer(audioCtxOut, (turnSeq) => {
            if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "playback_drained", turnSeq }));
          });
          ui.audioCtxOut = audioCtxOut;
          overlay.setModeView(currentMode, false);
          overlay.stateLine.textContent = "Готов: говорите";

          // Селектор микрофона: после первого разрешения подписи устройств доступны.
          const devices = await navigator.mediaDevices.enumerateDevices();
          const inputs = devices.filter((d) => d.kind === "audioinput");
          if (inputs.length > 1) {
            overlay.micSelect.innerHTML = "";
            for (const d of inputs) {
              const opt = document.createElement("option");
              opt.value = d.deviceId;
              opt.textContent = d.label || "Микрофон";
              overlay.micSelect.append(opt);
            }
            const activeId = track.getSettings().deviceId ?? "";
            for (const opt of [...overlay.micSelect.options]) opt.selected = opt.value === activeId;
            overlay.micSelect.style.display = "block";
            overlay.micSelect.onchange = async () => {
              const deviceId = overlay.micSelect.value;
              if (!deviceId) return;
              try {
                localStorage.setItem(MIC_PREF_KEY, deviceId);
                const next = await navigator.mediaDevices.getUserMedia({
                  audio: { ...base, deviceId: { exact: deviceId } },
                });
                (ui.stream as MediaStream).getTracks().forEach((t) => t.stop());
                ui.stream = next;
                sourceRef.source.disconnect();
                sourceRef.source = ctxIn.createMediaStreamSource(next);
                sourceRef.source.connect(worklet);
                overlay.micWarning.textContent = "";
              } catch (e) {
                overlay.micWarning.textContent = `Не удалось переключить микрофон: ${e instanceof Error ? e.message : String(e)}`;
              }
            };
          }
        } catch (e) {
          const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          overlay.stateLine.textContent = `Микрофон недоступен: ${message}`;
          sock.send(JSON.stringify({ type: "client_log", event: "mic_error", detail: message.slice(0, 200) }));
        }
        break;
      }
      case "thread":
        overlay.threadLine.textContent = "Записывается в тред звонка";
        break;
      case "state":
        overlay.stateLine.textContent = stateLabel(frame.state, frame.detail);
        overlay.setOrbState(frame.state);
        break;
      case "transcript":
        overlay.addTranscript(frame.role, frame.text, frame.final);
        if (frame.role === "owner" && frame.final) ownerHeard = true;
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
        currentMode = frame.mode;
        overlay.setModeView(frame.mode, frame.switching);
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
    switchMode: (mode) => {
      currentMode = mode;
      overlay.setModeView(mode, true);
      sock.send(JSON.stringify({ type: "switch_mode", mode }));
    },
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

const ORB_CSS = `
  @keyframes lc-orb-listen {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.06); }
  }
  @keyframes lc-orb-think {
    to { transform: rotate(360deg); }
  }
  @keyframes lc-orb-speak {
    0%, 100% { transform: scale(1); filter: brightness(1); }
    33% { transform: scale(1.1); filter: brightness(1.25); }
    66% { transform: scale(0.96); filter: brightness(0.95); }
  }
  #lc-orb {
    width: 56px; height: 56px; border-radius: 50%;
    margin: 0 auto; position: relative; flex: none;
    transition: background 0.35s ease, box-shadow 0.35s ease;
    background:
      radial-gradient(circle at 50% 42%,
        color-mix(in srgb, var(--lc-accent, #7aa2ff) 85%, #ffffff 15%) 0%,
        var(--lc-accent, #7aa2ff) 45%,
        color-mix(in srgb, var(--lc-accent, #7aa2ff) 55%, #0a0c14 45%) 100%);
    box-shadow: 0 0 18px color-mix(in srgb, var(--lc-accent, #7aa2ff) 45%, transparent);
  }
  #lc-orb::after {
    content: ""; position: absolute; inset: -6px; border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--lc-accent, #7aa2ff) 55%, transparent);
    opacity: 0; transition: opacity 0.3s ease;
  }
  #lc-orb[data-state="listening"] {
    animation: lc-orb-listen 1.6s ease-in-out infinite;
    transform: scale(calc(1 + var(--lc-level, 0) * 0.22));
  }
  #lc-orb[data-state="thinking"] {
    background:
      radial-gradient(circle at 50% 42%, #ffd98a 0%, #f5a623 45%, #7a4a00 100%);
    box-shadow: 0 0 18px rgba(245, 166, 35, 0.5);
  }
  #lc-orb[data-state="thinking"]::after {
    opacity: 1;
    border-color: transparent;
    border-top-color: #ffd98a;
    animation: lc-orb-think 0.9s linear infinite;
  }
  #lc-orb[data-state="speaking"] {
    background:
      radial-gradient(circle at 50% 42%, #b6ffd9 0%, #34d399 45%, #0a5c3c 100%);
    box-shadow: 0 0 22px rgba(52, 211, 153, 0.55);
    animation: lc-orb-speak 1.05s ease-in-out infinite;
  }
  #lc-orb[data-state="speaking"]::after { opacity: 0; }
  #lc-orb[data-state="muted"] {
    background: radial-gradient(circle at 50% 42%, #6b7280 0%, #374151 55%, #111827 100%);
    box-shadow: none;
  }
  #lc-orb[data-state="reconnecting"] {
    background: radial-gradient(circle at 50% 42%, #fecaca 0%, #ef4444 45%, #7f1d1d 100%);
    box-shadow: 0 0 18px rgba(239, 68, 68, 0.5);
    animation: lc-orb-listen 0.7s ease-in-out infinite;
  }
  .lc-btn-muted {
    background: rgba(239, 68, 68, 0.18) !important;
    border-color: rgba(239, 68, 68, 0.55) !important;
    color: #fca5a5 !important;
  }
`;

function buildOverlay() {
  const button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (button) button.style.display = "none";

  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.style.cssText = `
    position: fixed; right: 24px; bottom: 24px; z-index: 999999;
    width: 360px; max-width: calc(100vw - 16px); max-height: 70vh; display: flex; flex-direction: column;
    background: var(--color-canvas, #16171a); color: var(--color-ink, #e8e8ea);
    border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,.4); font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px; overflow: hidden; pointer-events: auto;
  `;
  const style = document.createElement("style");
  style.textContent = ORB_CSS;
  document.head.append(style);

  const header = document.createElement("div");
  header.style.cssText = "padding:12px 12px 8px; display:flex; flex-direction:column; align-items:center; gap:6px; border-bottom:1px solid rgba(255,255,255,.1);";
  const orbRow = document.createElement("div");
  orbRow.style.cssText = "display:flex; align-items:center; gap:10px; width:100%;";
  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;";
  title.textContent = "📞 Звонок";
  const orb = document.createElement("div");
  orb.id = "lc-orb";
  orb.dataset.state = "listening";
  const stateLine = document.createElement("div");
  stateLine.style.cssText = "opacity:.75; font-size:12px; text-align:center; min-height:16px;";
  orbRow.append(title, orb);
  header.append(orbRow, stateLine);

  const threadLine = document.createElement("div");
  threadLine.style.cssText = "padding:4px 12px; opacity:.5; font-size:11px;";
  const micWarning = document.createElement("div");
  micWarning.style.cssText = "padding:0 12px 4px; color:#ffb46e; font-size:11px; min-height:0;";
  const micSelect = document.createElement("select");
  micSelect.style.cssText = "margin:0 12px 6px; max-width: calc(100% - 24px); font-size:11px; display:none; background:var(--color-canvas,#16171a); color:inherit; border:1px solid rgba(255,255,255,.15); border-radius:6px; padding:2px;";

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
  const muteBtn = mkBtn("🎙 Микрофон", "Выключить микрофон (вас не слышно, агент продолжает говорить)");
  muteBtn.style.flex = "0.8";
  const endBtn = mkBtn("■ Завершить", "Завершить звонок");
  endBtn.style.borderColor = "rgba(255,100,100,.4)";

  // Режим: сегментный переключатель с подсветкой активного (макеты, раздел 2).
  const modeSeg = document.createElement("div");
  modeSeg.style.cssText = "display:flex; border:1px solid rgba(255,255,255,.15); border-radius:8px; overflow:hidden; flex:1.2;";
  const segNormal = document.createElement("button");
  const segExtended = document.createElement("button");
  const segStyle = (active: boolean, el: HTMLElement) => {
    el.style.cssText = `
      padding:8px 4px; font-size:11px; cursor:pointer; border:none; flex:1;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      background: ${active ? "var(--color-primary, #4f6ef7)" : "rgba(255,255,255,.04)"};
      color: ${active ? "#fff" : "inherit"};
      opacity: ${active ? 1 : 0.6};
      font-weight: ${active ? 600 : 400};
    `;
  };
  segNormal.textContent = "⚡ Обычный";
  segExtended.textContent = "🧠 Extended";
  segNormal.title = "Базовая модель: сама вызывает инструменты, отвечает быстрее";
  segExtended.title = "Extended Thinking: думает глубже, инструменты выбирает вторая модель";
  modeSeg.append(segNormal, segExtended);
  controls.append(muteBtn, modeSeg, endBtn);
  root.append(header, threadLine, micWarning, micSelect, log, confirmation, controls);
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

  const setMuteView = (m: boolean) => {
    muteBtn.textContent = m ? "🎙 Микрофон выкл" : "🎙 Микрофон";
    muteBtn.classList.toggle("lc-btn-muted", m);
    muteBtn.title = m ? "Включить микрофон" : "Выключить микрофон (вас не слышно, агент продолжает говорить)";
    if (m) orb.dataset.state = "muted";
    else orb.dataset.state = "listening";
  };
  muteBtn.onclick = () => {
    muted = !muted;
    setMuteView(muted);
    handlers?.mute(muted);
  };
  segNormal.onclick = () => handlers?.switchMode("normal");
  segExtended.onclick = () => handlers?.switchMode("extended");
  endBtn.onclick = () => handlers?.end();

  return {
    root,
    button: button as HTMLButtonElement,

    stateLine,
    threadLine,
    micWarning,
    micSelect,
    addTranscript(role: "owner" | "agent", text: string, final: boolean) {
      // Одна реплика — одна строка: куски дописываются, финал ПЕРЕЗАПИСЫВАЕТ ту же
      // строку целиком, а не добавляет дубль (репорт владельца 02.11).
      const prefix = role === "agent" ? "Агент: " : "Вы: ";
      const last = log.lastElementChild as HTMLElement | null;
      const reusable = last && last.dataset.role === role && !last.dataset.final;
      if (reusable) {
        if (final) {
          last.dataset.final = "1";
          last.dataset.text = text;
          last.textContent = `${prefix}${text}`;
        } else {
          last.dataset.text = (last.dataset.text ?? "") + text;
          last.textContent = `${prefix}${last.dataset.text}`;
        }
      } else {
        const row = document.createElement("div");
        row.style.cssText = `white-space:pre-wrap; ${role === "agent" ? "opacity:.92" : "opacity:.6;"}`;
        row.dataset.role = role;
        row.dataset.text = text;
        if (final) row.dataset.final = "1";
        row.textContent = `${prefix}${text}`;
        log.append(row);
      }
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
    setModeView(mode: string, switching: boolean) {
      segStyle(mode === "normal", segNormal);
      segStyle(mode === "extended", segExtended);
      segNormal.textContent = switching && mode === "normal" ? "⚡ Переключаюсь…" : "⚡ Обычный";
      segExtended.textContent = switching && mode === "extended" ? "🧠 Переключаюсь…" : "🧠 Extended";
      modeSeg.style.opacity = switching ? "0.6" : "1";
      modeSeg.style.pointerEvents = switching ? "none" : "auto";
    },
    setOrbState(state: string) {
      if (muted && state !== "ended") {
        orb.dataset.state = "muted";
        return;
      }
      orb.dataset.state = state === "connecting" || state === "ended" ? "listening" : state;
      stateLine.textContent = stateLabel(state);
      orb.style.setProperty("--lc-level", "0");
    },
    setOrbLevel(level: number) {
      if (orb.dataset.state === "listening") orb.style.setProperty("--lc-level", String(Math.min(1, level)));
    },
    setHandlers(h: typeof handlers) {
      handlers = h;
    },
  };
}

/**
 * Кнопка 📞: на десктопе правый нижний угол, на узких экранах — правый верхний,
 * под шапкой: внизу она накрывает кнопку отправки композера (баг-репорт владельца).
 */
const MOBILE_QUERY = "(max-width: 700px)";

export function mountCallButton(): () => void {
  if (typeof document === "undefined") return () => {};
  const existing = document.getElementById(BUTTON_ID);
  if (existing) existing.remove();
  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.title = "Позвонить координатору (живой голос)";
  btn.textContent = "📞";
  btn.style.cssText = `
    position: fixed; z-index: 999998;
    width: 44px; height: 44px; border-radius: 50%; border: 1px solid rgba(255,255,255,.15);
    background: var(--color-primary, #4f6ef7); color: #fff; font-size: 20px; cursor: pointer;
    box-shadow: 0 6px 20px rgba(0,0,0,.35); pointer-events: auto;
  `;
  const place = () => {
    if (window.matchMedia(MOBILE_QUERY).matches) {
      btn.style.cssText += `
        right: 12px; top: 68px; width: 40px; height: 40px; font-size: 18px;
      `;
    } else {
      btn.style.cssText += `
        right: 24px; bottom: 24px; width: 44px; height: 44px; font-size: 20px;
      `;
    }
  };
  place();
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener?.("change", place);
  btn.onclick = () => void startCall();
  document.body.append(btn);
  return () => {
    mq.removeEventListener?.("change", place);
    btn.remove();
  };
}
