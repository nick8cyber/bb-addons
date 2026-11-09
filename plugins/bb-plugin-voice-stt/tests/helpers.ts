/**
 * Тестовые помощники: поддельный WebSocket и JWT-фикстуры. Только синтетика —
 * никакой сети и реальных ключей.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocketLike } from "../src/gemini-live.js";

export class FakeWebSocket implements WebSocketLike {
  readonly sent: string[] = [];
  readyState = 0;
  closed = false;
  closeArgs: Array<number | string | undefined> = [];
  private emitter = new EventEmitter();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  static factory = (url: string): FakeWebSocket => new FakeWebSocket(url);
  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!ws) throw new Error("no FakeWebSocket created");
    return ws;
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeArgs = [code, reason];
    this.readyState = 3;
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    this.emitter.on(type, listener as (event: unknown) => void);
  }
  removeEventListener(type: string, listener: (event: never) => void): void {
    this.emitter.off(type, listener as (event: unknown) => void);
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.emitter.emit("open", { type: "open" });
  }
  simulateMessage(payload: unknown): void {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.emitter.emit("message", { type: "message", data });
  }
  simulateBinaryMessage(payload: unknown): void {
    const data = Buffer.from(JSON.stringify(payload));
    this.emitter.emit("message", { type: "message", data });
  }
  simulateClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.emitter.emit("close", { type: "close", code, reason });
  }
  simulateError(): void {
    this.emitter.emit("error", { type: "error" });
  }

  sentFrames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** JWT с произвольным payload (подпись не проверяется — как и в бандле). */
export function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.sig`;
}

/** Auth-claims в форме codex: `chatgpt_account_id` живёт под namespaced ключом. */
export function chatGptClaimsJwt(claims: Record<string, unknown>): string {
  return fakeJwt({ "https://api.openai.com/auth": claims });
}

/** Временная папка с `auth.json` — имитация CODEX_HOME. */
export function writeCodexHome(authJson: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "voice-stt-test-"));
  writeFileSync(join(dir, "auth.json"), typeof authJson === "string" ? authJson : JSON.stringify(authJson));
  return dir;
}

/** Фейковый Response для замоканного fetch. */
export function fakeResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

export interface RecordedFetch {
  url: string;
  form: FormData;
  headers: Headers;
}

/** fetch-мок: записывает вызовы, отвечает заготовленным Response. */
export function recordingFetch(
  responder: (call: RecordedFetch) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  const fetchImpl = (async (url: unknown, init?: { headers?: Headers; body?: FormData }) => {
    const call: RecordedFetch = {
      url: String(url),
      form: init?.body as FormData,
      headers: init?.headers ?? new Headers(),
    };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
