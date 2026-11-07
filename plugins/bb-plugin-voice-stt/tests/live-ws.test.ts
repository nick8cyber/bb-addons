import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiServiceFailure, type TranscribeOutput } from "../src/contract.js";
import { LiveTokenStore } from "../src/live-token.js";
import {
  BUSY_CLOSE_CODE,
  UNAUTHORIZED_CLOSE_CODE,
  createLiveVoiceHandler,
  pcmRms,
  type LiveSock,
  type LiveVoiceDeps,
  type LiveVoiceSessionCallbacks,
} from "../src/live-ws.js";

class FakeSock implements LiveSock {
  sent: string[] = [];
  closed = false;
  closeCode: number | undefined;
  readyState = 1; // OPEN
  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  }
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

class FakeSession {
  pushed: Buffer[] = [];
  opened = false;
  cancelled = false;
  endResult: string | Error = "текст";
  callbacks: LiveVoiceSessionCallbacks;
  constructor(cb: LiveVoiceSessionCallbacks) {
    this.callbacks = cb;
  }
  open(): void {
    this.opened = true;
  }
  push(chunk: Buffer): void {
    this.pushed.push(chunk);
  }
  async end(): Promise<string> {
    if (this.endResult instanceof Error) throw this.endResult;
    return this.endResult;
  }
  cancel(): void {
    this.cancelled = true;
  }
}

const pcm = (fill: number, bytes = 3200): Buffer => Buffer.alloc(bytes, fill);
/** PCM с RMS выше порога тишины: ±1000 int16. */
const speechPcm = (): Buffer => {
  const b = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) b.writeInt16LE(i % 2 === 0 ? 1000 : -1000, i * 2);
  return b;
};

function makeDeps(over: Partial<LiveVoiceDeps> = {}) {
  const tokens = new LiveTokenStore();
  const sessions: FakeSession[] = [];
  const fallbackCalls: Uint8Array[] = [];
  const deps: LiveVoiceDeps = {
    tokens,
    readConfig: async () => ({
      geminiKeys: ["k1", "k2"],
      geminiLiveModel: "m",
      language: null,
      vocabulary: [],
    }),
    createSession: (opts) => {
      const s = new FakeSession(opts);
      sessions.push(s);
      return s;
    },
    fallback: async (wav) => {
      fallbackCalls.push(wav);
      return { ok: true, text: "фоллбэк", engine: "codex" } satisfies TranscribeOutput;
    },
    ...over,
  };
  return { tokens, sessions, fallbackCalls, deps };
}

type Route = ReturnType<typeof createLiveVoiceHandler>;

/** Одна фабрика на маршрут — busy-синглтон живёт в её замыкании (§4.1). */
function makeRoute(deps: LiveVoiceDeps) {
  const route = createLiveVoiceHandler(deps);
  return () => {
    const handler = route({});
    const sock = new FakeSock();
    void handler.onOpen?.(sock);
    return { handler, sock };
  };
}

function connect(deps: LiveVoiceDeps) {
  return makeRoute(deps)();
}

async function hello(_deps: LiveVoiceDeps, handler: ReturnType<typeof connect>["handler"], sock: FakeSock, token: string) {
  await handler.onMessage?.(sock, JSON.stringify({ type: "hello", token }));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("live-ws (§4, §9)", () => {
  it("hello timeout closes 4009", async () => {
    const { deps } = makeDeps();
    const { sock } = connect(deps);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(sock.closed).toBe(true);
    expect(sock.closeCode).toBe(BUSY_CLOSE_CODE);
  });

  it("bad token → error + 4401", async () => {
    const { deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, "wrong");
    expect(sock.closeCode).toBe(UNAUTHORIZED_CLOSE_CODE);
    expect(sock.frames()[0]).toMatchObject({ type: "error", code: "unauthorized" });
  });

  it("valid hello opens a session; binary frames push audio", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    const token = tokens.issue();
    await hello(deps, handler, sock, token);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].opened).toBe(true);
    const data = pcm(1);
    await handler.onMessage?.(sock, new Uint8Array(data));
    expect(sessions[0].pushed).toHaveLength(1);
    await handler.onClose?.(sock, { code: 1000, reason: "" });
  });

  it("binary frames before hello are dropped", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await handler.onMessage?.(sock, new Uint8Array(pcm(1)));
    await hello(deps, handler, sock, tokens.issue());
    expect(sessions[0].pushed).toHaveLength(0);
    await handler.onClose?.(sock, { code: 1000, reason: "" });
  });

  it("second hello on a live connection → 4009", async () => {
    const { tokens, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    await hello(deps, handler, sock, tokens.issue());
    expect(sock.closeCode).toBe(BUSY_CLOSE_CODE);
    await handler.onClose?.(sock, { code: 1000, reason: "" });
  });

  it("second connection while one is live → 4009 busy", async () => {
    const { tokens, deps } = makeDeps();
    const route = makeRoute(deps);
    const first = route();
    await hello(deps, first.handler, first.sock, tokens.issue());
    const second = route();
    await hello(deps, second.handler, second.sock, tokens.issue());
    expect(second.sock.closeCode).toBe(BUSY_CLOSE_CODE);
    expect(second.sock.frames().at(-1)).toMatchObject({ type: "error", code: "busy" });
    await first.handler.onClose?.(first.sock, { code: 1000, reason: "" });
    await second.handler.onClose?.(second.sock, { code: 1000, reason: "" });
  });

  it("ready and interims are forwarded", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    sessions[0].callbacks.onSetupComplete();
    sessions[0].callbacks.onInterim("раз два");
    expect(sock.frames()).toContainEqual({ type: "ready" });
    expect(sock.frames()).toContainEqual({ type: "interim", text: "раз два" });
    await handler.onClose?.(sock, { code: 1000, reason: "" });
  });

  it("end → session.end → final gemini-live, socket closes", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    await handler.onMessage?.(sock, new Uint8Array(speechPcm()));
    await handler.onMessage?.(sock, JSON.stringify({ type: "end" }));
    expect(sock.frames().at(-1)).toMatchObject({ type: "final", text: "текст", engine: "gemini-live" });
    expect(sock.closeCode).toBe(1000);
  });

  it("silent PCM short-circuits to silence without calling end/fallback", async () => {
    const { tokens, sessions, fallbackCalls, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    await handler.onMessage?.(sock, new Uint8Array(pcm(0))); // тишина
    const endSpy = vi.spyOn(sessions[0], "end");
    await handler.onMessage?.(sock, JSON.stringify({ type: "end" }));
    expect(endSpy).not.toHaveBeenCalled();
    expect(fallbackCalls).toHaveLength(0);
    expect(sessions[0].cancelled).toBe(true);
    expect(sock.frames().at(-1)).toMatchObject({ type: "final", engine: "silence", text: "" });
  });

  it("empty transcript with real audio → fallback → final degraded", async () => {
    const { tokens, sessions, fallbackCalls, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    await handler.onMessage?.(sock, new Uint8Array(speechPcm()));
    sessions[0].endResult = "";
    await handler.onMessage?.(sock, JSON.stringify({ type: "end" }));
    expect(fallbackCalls).toHaveLength(1);
    // WAV: 44-байт заголовок + PCM
    expect(fallbackCalls[0].byteLength).toBe(44 + 3200);
    expect(String.fromCharCode(...fallbackCalls[0].subarray(0, 4))).toBe("RIFF");
    expect(sock.frames().at(-1)).toMatchObject({
      type: "final",
      text: "фоллбэк",
      engine: "codex",
      degraded: true,
    });
  });

  it("session failure → fallback → final degraded with engine", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    await handler.onMessage?.(sock, new Uint8Array(speechPcm()));
    sessions[0].endResult = new AiServiceFailure("timeout", "cap", "cap");
    await handler.onMessage?.(sock, JSON.stringify({ type: "end" }));
    expect(sock.frames().at(-1)).toMatchObject({ engine: "codex", degraded: true });
  });

  it("fallback failure → error frame", async () => {
    const { tokens, sessions, deps } = makeDeps({
      fallback: async () => ({ ok: false, code: "request_failed", message: "всё упало" }),
    });
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    await handler.onMessage?.(sock, new Uint8Array(speechPcm()));
    sessions[0].endResult = new Error("dead");
    await handler.onMessage?.(sock, JSON.stringify({ type: "end" }));
    expect(sock.frames().at(-1)).toMatchObject({ type: "error", message: "всё упало" });
  });

  it("pre-ready failure rotates to the next key and replays PCM", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    await handler.onMessage?.(sock, new Uint8Array(speechPcm()));
    sessions[0].callbacks.onFailure(new AiServiceFailure("auth_required", "bad_key", "bad key"));
    expect(sessions).toHaveLength(2);
    expect(sessions[1].pushed).toHaveLength(1); // реплей накопленного
    expect(sock.frames().every((f) => f.type !== "error")).toBe(true);
    await handler.onClose?.(sock, { code: 1000, reason: "" });
  });

  it("post-ready failure → error frame + close (no rotation)", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    sessions[0].callbacks.onSetupComplete();
    sessions[0].callbacks.onFailure(new AiServiceFailure("service_unavailable", "dead", "socket died"));
    expect(sessions).toHaveLength(1);
    expect(sock.frames().at(-1)).toMatchObject({ type: "error" });
    await handler.onClose?.(sock, { code: 1000, reason: "" });
  });

  it("cancel tears the session down without transcribing", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    await handler.onMessage?.(sock, new Uint8Array(speechPcm()));
    await handler.onMessage?.(sock, JSON.stringify({ type: "cancel" }));
    expect(sessions[0].cancelled).toBe(true);
    expect(sock.frames().every((f) => f.type !== "final")).toBe(true);
  });

  it("PCM cap forces finish", async () => {
    const { tokens, sessions, deps } = makeDeps({ pcmCapBytes: 4000 });
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    await handler.onMessage?.(sock, new Uint8Array(speechPcm()));
    await handler.onMessage?.(sock, new Uint8Array(speechPcm())); // 6400 > 4000
    expect(sock.frames().at(-1)).toMatchObject({ type: "final" });
  });

  it("socket close kills the session (no resume, §4.3а)", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const route = makeRoute(deps);
    const { handler, sock } = route();
    await hello(deps, handler, sock, tokens.issue());
    await handler.onClose?.(sock, { code: 1006, reason: "" });
    expect(sessions[0].cancelled).toBe(true);
    // Слот освободился — новое подключение на том же route не busy.
    const second = route();
    await hello(deps, second.handler, second.sock, tokens.issue());
    expect(second.sock.closeCode).toBeUndefined();
    await second.handler.onClose?.(second.sock, { code: 1000, reason: "" });
  });

  it("no Gemini keys → error + close", async () => {
    const { tokens, deps } = makeDeps({
      readConfig: async () => ({ geminiKeys: [], geminiLiveModel: "m", language: null, vocabulary: [] }),
    });
    const { handler, sock } = connect(deps);
    await hello(deps, handler, sock, tokens.issue());
    expect(sock.frames().at(-1)).toMatchObject({ type: "error", code: "no_keys" });
    expect(sock.closed).toBe(true);
  });

  it("BLOCKER: dead active socket allows takeover, old session is cancelled", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const route = makeRoute(deps);
    const first = route();
    await hello(deps, first.handler, first.sock, tokens.issue());
    first.sock.readyState = 3; // CLOSED — onClose сервером ещё не обработан (гонка)
    const second = route();
    await hello(deps, second.handler, second.sock, tokens.issue());
    expect(second.sock.closeCode).toBeUndefined();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].cancelled).toBe(true);
    await second.handler.onClose?.(second.sock, { code: 1000, reason: "" });
  });

  it("REMARK: PCM before openSession is pushed into the session in order", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    const token = tokens.issue();
    const helloPromise = hello(deps, handler, sock, token);
    // readConfig ещё летит — кадры приходят до создания сессии.
    await handler.onMessage?.(sock, new Uint8Array(speechPcm()));
    await helloPromise;
    expect(sessions[0].pushed).toHaveLength(1);
    await handler.onClose?.(sock, { code: 1000, reason: "" });
  });

  it("token never appears in outgoing frames", async () => {
    const { tokens, sessions, deps } = makeDeps();
    const { handler, sock } = connect(deps);
    const token = tokens.issue();
    await hello(deps, handler, sock, token);
    sessions[0].callbacks.onInterim("x");
    await handler.onMessage?.(sock, JSON.stringify({ type: "end" }));
    expect(sock.sent.every((f) => !f.includes(token))).toBe(true);
  });
});

describe("pcmRms", () => {
  it("zero PCM → 0, constant ±1000 → 1000", () => {
    expect(pcmRms(pcm(0))).toBe(0);
    expect(pcmRms(speechPcm())).toBeCloseTo(1000, 0);
  });
});
