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
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", (ev) => {
      this.ws = null;
      this.emit("close", (ev as CloseEvent).code, (ev as CloseEvent).reason);
    });
    ws.addEventListener("error", () => this.emit("error", "websocket error"));
  }

  private send(msg: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private setupMessage(): unknown {
    const setup: Record<string, unknown> = {
      model: `models/${this.opts.model}`,
      generationConfig: { responseModalities: ["AUDIO"] },
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.opts.voice } },
        languageCode: this.opts.languageCode,
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: this.opts.systemInstruction }] },
    };
    if (this.opts.thinkingLevel) {
      setup.thinkingConfig = { thinkingLevel: this.opts.thinkingLevel };
    }
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
      this.emit("goAway", (msg.goAway as { timeLeft?: string | number }).timeLeft ?? 0);
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
      if (content.turnComplete || content.generationComplete) {
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

  sendAudio(pcm: Uint8Array): void {
    const b64 = Buffer.from(pcm).toString("base64");
    this.send({ realtimeInput: { audio: { data: b64, mimeType: "audio/pcm;rate=16000" } } });
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

  sendToolResponse(functionId: string | undefined, response: unknown, scheduling: "SILENT" | "WHEN_IDLE" | "INTERRUPT" = "SILENT"): void {
    const call = functionId !== undefined ? { id: functionId } : {};
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
}
