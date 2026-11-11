/**
 * LiveClient: WebSocket к Gemini Live API (контракт §3).
 * Тонкий клиент: setup, аудио, перебивание, транскрипты, goAway, resumption,
 * usageMetadata. Протокольные решения (смена ключа, маршрутизация) — в CallSession.
 */
import { EventEmitter } from "node:events";

export interface LiveClientOptions {
  key: string;
  model: string;
  voice: string;
  languageCode: string;
  systemInstruction: string;
  /** `thinkingConfig.thinkingLevel` — только Extended Thinking (спека §1). */
  thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
  tools?: unknown[];
  /** Родительский turnSeq для аудио модели — чтобы плеер сбрасывал буфер по ходам. */
  turnSeqBase?: number;
  sessionHandle?: string;
  contextWindowCompression?: { triggerTokens: number; targetTokens: number };
  wsFactory?: (url: string) => WebSocket;
}

export type LiveEvents = {
  open: [];
  setupComplete: [];
  /** PCM16 24 кГц моно, кусок хода. */
  audio: [turnSeq: number, pcm: Uint8Array];
  interrupted: [turnSeq: number | null];
  inputTranscript: [text: string, final: boolean];
  outputTranscript: [text: string, final: boolean];
  turnComplete: [];
  toolCall: [calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>];
  goAway: [timeLeftSec: number];
  sessionHandle: [handle: string];
  usage: [promptTokens: number];
  close: [code: number, reason: string];
  error: [message: string];
};

/** Публичный тип событий LiveClient (Node EventEmitter без строгой типизации — обёртка ниже). */
export type LiveClientEvent = keyof LiveEvents;

const WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export class LiveClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private turnSeq: number;
  private openTurnSeq: number | null = null;
  private handle: string | null;
  readonly model: string;

  constructor(private opts: LiveClientOptions) {
    super();
    this.turnSeq = opts.turnSeqBase ?? 0;
    this.handle = opts.sessionHandle ?? null;
    this.model = opts.model;
  }

  connect(): void {
    const url = `${WS_URL}?key=${encodeURIComponent(this.opts.key)}`;
    const ws = (this.opts.wsFactory ?? ((u: string) => new WebSocket(u)))(url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.sendSetup();
      this.emit("open");
    });
    ws.addEventListener("message", (ev) => {
      // Рантайм bb-сервера доставляет кадры Gemini бинарными — принимаем и строки, и байты.
      const d = (ev as MessageEvent).data;
      if (typeof d === "string") {
        this.onMessage(d);
        return;
      }
      if (d instanceof Blob) {
        void d.text().then((t) => this.onMessage(t));
        return;
      }
      const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : (d as Uint8Array);
      this.onMessage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
    });
    ws.addEventListener("close", (ev) => {
      this.ws = null;
      this.emit("close", (ev as CloseEvent).code, (ev as CloseEvent).reason);
    });
    ws.addEventListener("error", () => this.emit("error", "websocket error"));
  }

  private send(msg: unknown): boolean {
    try {
      const openConst = (WebSocket as unknown as { OPEN?: number }).OPEN;
      const open = typeof openConst === "number" ? openConst : 1;
      if (this.ws && this.ws.readyState === open) {
        this.ws.send(JSON.stringify(msg));
        return true;
      } else {
        this.emit("sendDropped", this.ws ? this.ws.readyState : "no-socket", JSON.stringify(msg).slice(0, 80));
        return false;
      }
    } catch (e) {
      this.emit("error", `send failed: ${String(e)}`);
      return false;
    }
  }

  private setupMessage(): unknown {
    // У 3.8-live speechConfig живёт ВНУТРИ generationConfig (проверено живой пробой:
    // setup.speechConfig отклоняется 1007 "Unknown name").
    const speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: this.opts.voice } },
      languageCode: this.opts.languageCode,
    };
    // thinkingConfig — тоже внутри generationConfig: в корне setup Google отвечает
    // 1007 "Unknown name thinkingConfig at 'setup'" (найдено живой проверкой Extended 02.11).
    const generationConfig: Record<string, unknown> = { responseModalities: ["AUDIO"], speechConfig };
    if (this.opts.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: this.opts.thinkingLevel };
    const setup: Record<string, unknown> = {
      model: `models/${this.opts.model}`,
      generationConfig,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: this.opts.systemInstruction }] },
    };
    if (this.opts.tools?.length) setup.tools = this.opts.tools;
    if (this.handle) setup.sessionResumption = { handle: this.handle };
    if (this.opts.contextWindowCompression) {
      setup.contextWindowCompression = {
        triggerTokens: this.opts.contextWindowCompression.triggerTokens,
        slidingWindow: { targetTokens: this.opts.contextWindowCompression.targetTokens },
      };
    }
    return { setup };
  }

  private onMessage(raw: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.setupComplete !== undefined) {
      this.emit("setupComplete");
      return;
    }
    if (msg.sessionResumptionUpdate !== undefined) {
      const u = msg.sessionResumptionUpdate as { newHandle?: string; resumable?: boolean };
      if (u.newHandle && u.resumable !== false) {
        this.handle = u.newHandle;
        this.emit("sessionHandle", u.newHandle);
      }
    }
    if (msg.goAway !== undefined) {
      const raw = (msg.goAway as { timeLeft?: string | number }).timeLeft ?? 0;
      const parsed = typeof raw === "number" ? raw : parseFloat(String(raw)) || 0;
      this.emit("goAway", parsed);
    }
    if (msg.usageMetadata !== undefined) {
      const u = msg.usageMetadata as { promptTokenCount?: number };
      this.emit("usage", u.promptTokenCount ?? 0);
    }
    if (msg.toolCall !== undefined) {
      const calls = (msg.toolCall as { functionCalls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }> }).functionCalls ?? [];
      this.emit("toolCall", calls.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })));
    }
    const content = msg.serverContent as
      | {
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          modelTurn?: { parts?: Array<{ text?: string; inlineData?: { data?: string } }> };
          interrupted?: boolean;
          turnComplete?: boolean;
          generationComplete?: boolean;
        }
      | undefined;
    if (content) {
      if (content.interrupted) {
        this.emit("interrupted", this.openTurnSeq);
        this.openTurnSeq = null;
      }
      if (content.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          if (part.inlineData?.data) {
            if (this.openTurnSeq === null) {
              this.turnSeq += 1;
              this.openTurnSeq = this.turnSeq;
            }
            this.emit("audio", this.openTurnSeq, Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0)));
          }
        }
      }
      if (content.inputTranscription?.text) this.emit("inputTranscript", content.inputTranscription.text, false);
      if (content.outputTranscription?.text) this.emit("outputTranscript", content.outputTranscription.text, false);
      // Только turnComplete — конец реплики. generationComplete приходит между
      // предложениями: если считать его концом хода, ответ дробится на отдельные
      // сообщения, а аудио сегментов накладывается друг на друга (инцидент 02.11 20:4x).
      if (content.turnComplete) {
        if (this.openTurnSeq !== null) {
          this.emit("audio", this.openTurnSeq, new Uint8Array(0)); // нулевой кусок = конец хода
          this.openTurnSeq = null;
        }
        this.emit("outputTranscript", "", true);
        this.emit("turnComplete");
      }
    }
  }

  /** Открыть setup (v1beta ожидает setup первым кадром после open). */
  sendSetup(): void {
    this.send(this.setupMessage());
  }

  sendAudio(pcm: Uint8Array): boolean {
    const b64 = Buffer.from(pcm).toString("base64");
    return this.send({ realtimeInput: { audio: { data: b64, mimeType: "audio/pcm;rate=16000" } } });
  }

  /** Текст владельца в ROUTER (вариант А, контракт §3). Транскрипт ROUTER никому не виден. */
  sendRealtimeText(text: string): void {
    this.send({ realtimeInput: { text } });
  }

  /**
   * Вставка серверного текста (контракт §3): turnComplete true — модель отвечает
   * голосом, false — молчит и ждёт владельца.
   */
  sendClientContent(text: string, turnComplete: boolean): void {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete } });
  }

  sendToolResponse(functionId: string | undefined, response: unknown, scheduling: "SILENT" | "WHEN_IDLE" | "INTERRUPT" = "SILENT", functionName?: string): void {
    const call: Record<string, unknown> = {};
    if (functionId !== undefined) call.id = functionId;
    if (functionName !== undefined) call.name = functionName;
    this.send({
      toolResponse: {
        functionResponses: [{ ...call, response, scheduling }],
      },
    });
  }

  close(): void {
    this.ws?.close(1000, "call ended");
    this.ws = null;
  }

  get sessionHandle(): string | null {
    return this.handle;
  }

  get nextTurnSeq(): number {
    return this.turnSeq + 1;
  }

  /**
   * Ход, чей транскрипт сейчас идёт (§7.2.1): открытый аудио-ход. Между
   * turnComplete и первым звуком следующего хода — null: кусок транскрипта
   * нельзя приписывать следующему номеру, звука у него ещё нет, и шлюз
   * разрешает такой якорь по следующему ходу со звуком.
   */
  get currentTurnSeq(): number | null {
    return this.openTurnSeq;
  }
}
