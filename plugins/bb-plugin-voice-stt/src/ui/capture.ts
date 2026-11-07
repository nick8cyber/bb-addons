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

export interface MicCaptureLike {
  /** Синхронно создать и разбудить AudioContext — вызывать из pointer-обработчика. */
  unlock(): void;
  /** Поднять getUserMedia + цепочку захвата; чанки идут в onChunk. */
  start(onChunk: (pcm: Uint8Array, level: number) => void): Promise<void>;
  stop(): void;
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
   * await в start проверяет поколение; устаревшее → треки глушатся сразу.
   */
  private generation = 0;

  /** iOS: AudioContext живёт, только если создан и запущен прямо в нажатии. */
  unlock(): void {
    // Идемпотентно: FAB будит контекст на касании, pressStart — повторно.
    if (this.ctx !== null && this.ctx.state !== "closed") {
      void this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
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

  async start(onChunk: (pcm: Uint8Array, level: number) => void): Promise<void> {
    const gen = this.generation;
    const stale = (): boolean => gen !== this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (stale()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    let ctx = this.ctx;
    if (!ctx || ctx.state === "closed") {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("AudioContext недоступен");
      }
      ctx = new AC();
      this.ctx = ctx;
    }
    await ctx.resume().catch(() => {});
    if (stale()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
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
      onChunk(new Uint8Array(i16.buffer), Math.min(1, peak * 2.2));
    };

    let node: AudioNode;
    try {
      if (!ctx.audioWorklet) throw new Error("AudioWorklet недоступен");
      await ctx.audioWorklet.addModule(
        URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" })),
      );
      if (stale()) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const worklet = new AudioWorkletNode(ctx, "voice-stt-capture");
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => emit(e.data);
      node = worklet;
    } catch {
      if (stale()) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // Запасной путь (старый WebKit): ScriptProcessor + то же прореживание.
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
  }

  stop(): void {
    this.generation += 1;
    try {
      this.captureNode?.disconnect();
      this.source?.disconnect();
    } catch {
      // узлы уже отсоединены
    }
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
    this.captureNode = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}
