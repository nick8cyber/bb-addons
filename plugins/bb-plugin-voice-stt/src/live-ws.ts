/**
 * Серверная сторона WS `/live-voice` (спека voice-stt-live §4): токены,
 * hello-гейт, буфер PCM, end/cancel, проброс интеримов/финала клиенту и
 * фоллбэк PCM→WAV→host-RPC (skipStages ["gemini-live"] → codex→groq).
 *
 * Чистая логика без привязки к SDK-типам: фабрика отдаёт объект с
 * onOpen/onMessage/onClose, структурно совместимый с
 * `bb.http.experimental_websocket` — тесты гоняют его без сети.
 */
import { AiServiceFailure, type EngineId, type TranscribeOutput } from "./contract.js";
import type { LiveTokenStore } from "./live-token.js";
import { pcmToWav } from "./wav.js";

/** Конвенция кодов как у live-call (§4.1): 44xx — отказ, 40xx — busy/timeout. */
export const UNAUTHORIZED_CLOSE_CODE = 4401;
export const BUSY_CLOSE_CODE = 4009;
export const HELLO_TIMEOUT_MS = 3_000;
/** Серверный cap накопленного PCM (§4.2): превышение → принудительный end. */
export const LIVE_PCM_CAP_BYTES = 10 * 1024 * 1024;
/**
 * Порог «RMS ≈ тишина» для пустого финала (§4.4 а): калибруется как
 * mic-гейт live-call engine (peak 0.01 f32 ≈ 328 int16; берём RMS 400 —
 * честная речь держится заметно выше, шумовая полка — ниже).
 */
export const SILENCE_RMS_INT16 = 400;

const CLOSE_NORMAL = 1_000;
const CLOSE_INTERNAL = 4_000;

export interface LiveSock {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** DOM-конвенция: 2 CLOSING / 3 CLOSED → соединение мертво (гонка §4.3а). */
  readonly readyState?: number;
}

export interface LiveVoiceSocketHandlers {
  onOpen?(sock: LiveSock): void | Promise<void>;
  onMessage?(sock: LiveSock, data: string | Uint8Array): void | Promise<void>;
  onClose?(sock: LiveSock, event: { code: number; reason: string }): void | Promise<void>;
  onError?(sock: LiveSock, error: Error): void;
}

export type LiveVoiceWsHandler = (context: unknown) => LiveVoiceSocketHandlers;

/** Минимальная поверхность потоковой сессии для оркестрации (§4.3). */
export interface LiveVoiceSessionLike {
  open(): void;
  push(chunk: Buffer): void;
  end(): Promise<string>;
  cancel(): void;
}

export interface LiveVoiceConfig {
  geminiKeys: string[];
  geminiLiveModel: string;
  language: string | null;
  vocabulary: string[];
}

export interface LiveVoiceSessionCallbacks {
  onInterim(text: string): void;
  onSetupComplete(): void;
  onFailure(failure: AiServiceFailure): void;
}

export interface LiveVoiceDeps {
  tokens: Pick<LiveTokenStore, "consume">;
  readConfig(): Promise<LiveVoiceConfig>;
  createSession(options: {
    apiKey: string;
    model: string;
    language: string | null;
    vocabulary: string[];
  } & LiveVoiceSessionCallbacks): LiveVoiceSessionLike;
  /** PCM→WAV уже сделан — здесь только host-RPC codex→groq (§4.5). */
  fallback(wav: Uint8Array): Promise<TranscribeOutput>;
  log?: (message: string) => void;
  helloTimeoutMs?: number;
  pcmCapBytes?: number;
}

type ServerFrame =
  | { type: "ready" }
  | { type: "interim"; text: string }
  | { type: "final"; text: string; engine: EngineId | "silence"; degraded?: boolean }
  | { type: "error"; code: string; message: string };

interface ConnState {
  sock: LiveSock;
  authed: boolean;
  helloTimer: ReturnType<typeof setTimeout> | null;
  session: LiveVoiceSessionLike | null;
  /** Вся запись (фоллбэк WAV §4.5 и RMS-тишина §4.4). */
  pcm: Buffer[];
  pcmBytes: number;
  config: LiveVoiceConfig | null;
  keyIndex: number;
  ready: boolean;
  finishing: boolean;
  torn: boolean;
  /** Снос состояния соединения — доступен и соседнему hello (takeover). */
  teardown(): void;
}

/** RMS int16-выборок накопленного PCM. */
export function pcmRms(pcm: Buffer): number {
  const samples = pcm.byteLength >> 1;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

export function createLiveVoiceHandler(deps: LiveVoiceDeps): LiveVoiceWsHandler {
  const log = deps.log ?? (() => {});
  const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const pcmCapBytes = deps.pcmCapBytes ?? LIVE_PCM_CAP_BYTES;
  /** Одна живая сессия на сервер (§4.1, §4.6): второй hello → 4009 busy. */
  let active: ConnState | null = null;

  return () => {
    const state: ConnState = {
      sock: null as unknown as LiveSock,
      authed: false,
      helloTimer: null,
      session: null,
      pcm: [],
      pcmBytes: 0,
      config: null,
      keyIndex: 0,
      ready: false,
      finishing: false,
      torn: false,
      teardown: () => {},
    };

    const send = (frame: ServerFrame): void => {
      try {
        state.sock.send(JSON.stringify(frame));
      } catch {
        // сокет уже закрыт
      }
    };

    const sendError = (code: string, message: string): void => {
      send({ type: "error", code, message });
    };

    const teardown = (): void => {
      if (state.torn) return;
      state.torn = true;
      if (state.helloTimer !== null) {
        clearTimeout(state.helloTimer);
        state.helloTimer = null;
      }
      state.session?.cancel();
      state.session = null;
      state.pcm = [];
      if (active === state) active = null;
    };
    state.teardown = teardown;

    /** Открыть сессию на ключе keyIndex; до ready сбой → следующий ключ. */
    const openSession = (): void => {
      const config = state.config;
      if (config === null) return;
      const apiKey = config.geminiKeys[state.keyIndex];
      if (apiKey === undefined) return;
      const session = deps.createSession({
        apiKey,
        model: config.geminiLiveModel,
        language: config.language,
        vocabulary: config.vocabulary,
        onInterim: (text) => send({ type: "interim", text }),
        onSetupComplete: () => {
          state.ready = true;
          send({ type: "ready" });
        },
        onFailure: (failure) => {
          if (state.torn || state.finishing) return;
          const keys = state.config?.geminiKeys ?? [];
          if (!state.ready && state.keyIndex + 1 < keys.length) {
            // Ключ не поднялся — ротация до ready (§4.5/§6.4): буфер PCM
            // переливаем в новую сессию, клиент ничего не замечает.
            state.keyIndex += 1;
            log(`live-voice: key ${state.keyIndex} failed (${failure.detailCode}), trying key ${state.keyIndex + 1}`);
            openSession();
            for (const chunk of state.pcm) state.session?.push(chunk);
            return;
          }
          log(`live-voice: session failed ${failure.detailCode}: ${failure.message}`);
          sendError(failure.code, failure.message);
          try {
            state.sock.close(CLOSE_INTERNAL, "session failed");
          } catch {
            // уже закрыт
          }
        },
      });
      state.session = session;
      session.open();
    };

    /**
     * Финиш по §4.4/§4.5: тишина → silence без фоллбэка; пустой финал при
     * живом звуке или сбой сессии → PCM→WAV→host-RPC codex→groq.
     */
    const finish = async (): Promise<void> => {
      if (state.finishing || state.torn) return;
      state.finishing = true;
      const pcm = Buffer.concat(state.pcm);
      const silent = pcm.byteLength === 0 || pcmRms(pcm) < SILENCE_RMS_INT16;
      const endSession = async (): Promise<string | null> => {
        const session = state.session;
        if (session === null) return null;
        try {
          return (await session.end()).trim();
        } catch {
          return null;
        }
      };
      if (silent) {
        state.session?.cancel();
        send({ type: "final", text: "", engine: "silence" });
      } else {
        const text = await endSession();
        // Сокет умер за время ожидания — фоллбэк на труп не звать.
        if (state.torn) return;
        if (text !== null && text !== "") {
          send({ type: "final", text, engine: "gemini-live" });
        } else {
          // Звук был, а Gemini молчит/упал — мягкий провал → фоллбэк §4.5.
          log(`live-voice: ${text === "" ? "empty transcript" : "session failure"} — WAV fallback`);
          try {
            const res = await deps.fallback(pcmToWav(pcm));
            if (state.torn) return;
            if (res.ok) {
              send({ type: "final", text: res.text, engine: res.engine, degraded: true });
            } else {
              sendError(res.code, res.message);
            }
          } catch (e) {
            if (!state.torn) {
              sendError("request_failed", e instanceof Error ? e.message : String(e));
            }
          }
        }
      }
      try {
        state.sock.close(CLOSE_NORMAL, "done");
      } catch {
        // уже закрыт
      }
      teardown();
    };

    const onHello = async (token: unknown): Promise<void> => {
      if (state.authed) {
        // Второй hello на живом соединении — busy (§4.1).
        sendError("busy", "session already started");
        state.sock.close(BUSY_CLOSE_CODE, "second hello");
        return;
      }
      if (state.helloTimer !== null) {
        clearTimeout(state.helloTimer);
        state.helloTimer = null;
      }
      if (typeof token !== "string" || !deps.tokens.consume(token)) {
        sendError("unauthorized", "invalid or expired token");
        state.sock.close(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
        return;
      }
      if (active !== null) {
        const rs = active.sock.readyState;
        if (rs === undefined || rs < 2) {
          sendError("busy", "another live dictation is in progress");
          state.sock.close(BUSY_CLOSE_CODE, "busy");
          return;
        }
        // Старый сокет уже dead (CLOSING/CLOSED), а клиентский реплей пришёл
        // раньше onClose — разрешаем takeover, иначе 4009-гонка (§4.3а).
        log("live-voice: taking over a dead connection");
        active.teardown();
      }
      state.authed = true;
      active = state;
      try {
        state.config = await deps.readConfig();
      } catch (e) {
        sendError("request_failed", e instanceof Error ? e.message : String(e));
        state.sock.close(CLOSE_INTERNAL, "config failed");
        return;
      }
      // Сокет мог умереть за время await — сессию на трупе не поднимать.
      if (state.torn) return;
      if (state.config.geminiKeys.length === 0) {
        sendError("no_keys", "no Gemini keys configured");
        state.sock.close(CLOSE_INTERNAL, "no keys");
        return;
      }
      openSession();
      // Окно до openSession: PCM, прилетевший за время readConfig, не теряем —
      // доливаем в сессию в порядке прихода (она добуферит до setupComplete).
      for (const chunk of state.pcm) state.session?.push(chunk);
    };

    return {
      onOpen: (sock) => {
        state.sock = sock;
        state.helloTimer = setTimeout(() => {
          state.helloTimer = null;
          if (!state.authed) sock.close(BUSY_CLOSE_CODE, "hello timeout");
        }, helloTimeoutMs);
      },

      onMessage: (sock, data) => {
        if (state.torn) return;
        if (typeof data === "string") {
          let msg: unknown;
          try {
            msg = JSON.parse(data);
          } catch {
            return;
          }
          const type =
            msg !== null && typeof msg === "object"
              ? (msg as Record<string, unknown>)["type"]
              : undefined;
          if (type === "hello") {
            return onHello((msg as Record<string, unknown>)["token"]);
          }
          if (!state.authed) return;
          if (type === "end") {
            return finish();
          }
          if (type === "cancel") {
            teardown();
            try {
              sock.close(CLOSE_NORMAL, "cancelled");
            } catch {
              // уже закрыт
            }
            return;
          }
          return;
        }
        // Бинарные кадры до hello — дроп, не накапливать до авторизации.
        if (!state.authed || state.finishing) return;
        const chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        state.pcm.push(chunk);
        state.pcmBytes += chunk.byteLength;
        state.session?.push(chunk);
        if (state.pcmBytes > pcmCapBytes) return finish();
      },

      onClose: () => {
        // Обрыв сокета: серверная сессия умирает, резюма нет (§4.3а) —
        // клиент сам решит: реплей в новую сессию или файловая цепочка.
        teardown();
      },

      onError: (sock, error) => {
        log(`live-voice: socket error: ${error.message}`);
        teardown();
      },
    };
  };
}
