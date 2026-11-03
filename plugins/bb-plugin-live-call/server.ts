/**
 * bb-plugin-live-call — серверная точка входа.
 *
 * Ключи живут только здесь (secret-настройка, файл 0600), WebSocket к Google
 * открывает сервер: Google видит только IP хоста BB, не владельца (ADR-0005).
 * Браузер ходит только в BB через Connect.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  BUSY_CLOSE_CODE,
  FRAME_MIC,
  FRAME_PLAYBACK,
  HELLO_TIMEOUT_MS,
  parseFrame,
  packFrame,
  clientFrame,
  type ServerFrame,
} from "./src/contract.js";
import { CallSession } from "./src/call-session.js";
import { CallStore } from "./src/call-store.js";
import { EventBridge } from "./src/event-bridge.js";
import { LiveClient } from "./src/live-client.js";
import { argsHash } from "./src/confirmation-gate.js";
import { decideHello } from "./src/reattach.js";
import { toolByName } from "./src/tools.js";
import { createCallThreadManager, closeStaleCallThreads } from "./src/thread-lifecycle.js";

const rpcContract = defineRpcContract({
  status: {
    input: z.object({}).strict(),
    output: z.object({
      configured: z.boolean(),
      keys: z.number().int().min(0).max(2),
      activeCall: z
        .object({ callId: z.string(), threadId: z.string().nullable(), mode: z.string(), startedAt: z.number() })
        .nullable(),
    }),
  },
  /** Диагностика браузера, когда WebSocket звонка не открылся (iOS, Connect). */
  clientLog: {
    input: z.object({ event: z.string().min(1).max(60), detail: z.string().max(500).optional() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  probe: {
    input: z.object({}).strict(),
    output: z.object({
      extendedNativeTools: z.boolean(),
      checkedAt: z.string(),
      detail: z.string().optional(),
    }),
  },
});

type Sock = { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void };

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    geminiKeys: {
      type: "string",
      secret: true,
      label: "Ключи Gemini (AI Studio)",
      description: "1–2 ключа, по одному на строку. Первый — основной, второй — запасной. Live WebSocket шлюз CLIProxy не проксирует, поэтому ключи нужны прямые.",
    },
    defaultMode: {
      type: "string",
      label: "Режим по умолчанию",
      description: "extended (по умолчанию) — Extended Thinking с помощником для инструментов; normal — «Быстрый»: базовая gemini-3.8-live.",
    },
    extendedThinkingLevel: { type: "string", label: "Уровень мышления Extended", description: "Только для VOICE в режиме extended." },
    voice: { type: "string", label: "Голос", description: "По умолчанию Algenib — выбор владельца 02.11." },
    languageCode: { type: "string", label: "Язык", description: "ru-RU по умолчанию." },
    maxCallMinutes: { type: "number", label: "Максимум минут", description: "За 2 мин до конца агент предупреждает." },
    routerInput: {
      type: "string",
      label: "Вход маршрутизатора",
      description: "text — реплика из транскрипта VOICE (вариант А), audio — то же аудио в обе сессии (вариант Б). Замер — Ф0(д).",
    },
    callsProjectId: { type: "string", label: "Проект «Звонки»", description: "Оставь пустым: плагин создаст проект сам при первом звонке." },
    callsWorkspacePath: { type: "string", label: "Папка проекта «Звонки»", description: "Пустая папка на основном хосте, код в ней не живёт." },
  });

  const str = (v: unknown, fallback: string): string => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length > 0 ? s : fallback;
  };
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;

  const store = new CallStore(bb.storage.database());
  const bridges = new Set<Sock>();
  const bridgeOwner = new Map<string, Sock>();
  const turnClosedWaiters = new Map<string, () => void>();

  /** link.sock меняется при переподключении браузера; detached — браузер отвалился, ждём возврата. */
  let active: {
    session: CallSession;
    startedAt: number;
    link: { sock: Sock };
    detached: boolean;
    grace: NodeJS.Timeout | null;
  } | null = null;
  const REATTACH_GRACE_MS = 20_000;
  const eventBridge = new EventBridge();
  /** Кеш id проекта «Звонки»: фильтр автопрочтения (треды звонков не должны маячить непрочитанными). */
  let callsProjectCache: string | null = null;

  /** bridge-data/server.json: мост без BB_* переменных читает URL отсюда (контракт §7). */
  const writeServerJson = () => {
    try {
      const dir = join(bb.server.experimental_dataDir, "plugins", "live-call", "bridge-data");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "server.json"), JSON.stringify({ url: bb.server.loopbackBaseUrl, protocol: 1 }));
    } catch (e) {
      bb.log.warn(`server.json failed: ${String(e)}`);
    }
  };
  setTimeout(writeServerJson, 500);

  const settings_get = async () => settings.get();
  const keysList = async (): Promise<string[]> => {
    const raw = (await settings_get()).geminiKeys;
    if (typeof raw !== "string") return [];
    return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 2);
  };

  /** Проект «Звонки»: создаётся при первом звонке (контракт §6 п. 1). */
  const ensureCallsProject = async (): Promise<string> => {
    const cfg = await settings_get();
    const saved = str(cfg.callsProjectId, "");
    if (saved) return saved;
    const path = str(cfg.callsWorkspacePath, join(homedir(), "bb-calls"));
    mkdirSync(path, { recursive: true });
    let hostId = "";
    try {
      const sys = (await (bb.sdk as unknown as { system: { config(): Promise<{ primaryHostId?: string }> } }).system.config()) as { primaryHostId?: string };
      hostId = sys.primaryHostId ?? "";
    } catch {
      hostId = "";
    }
    if (!hostId) {
      const hosts = (await (bb.sdk as unknown as { hosts: { list(): Promise<{ hosts?: Array<{ id?: string }> }> } }).hosts.list()) as { hosts?: Array<{ id?: string }> };
      hostId = hosts.hosts?.[0]?.id ?? "";
    }
    if (!hostId) throw new Error("не найден основной хост для проекта «Звонки»");
    const created = (await (bb.sdk as unknown as {
      projects: { create(a: { name: string; source: { type: "local_path"; hostId: string; path: string } }): Promise<{ id: string }> };
    }).projects.create({ name: "Звонки", source: { type: "local_path", hostId, path } })) as { id: string };
    await settings.experimental_set({ callsProjectId: created.id });
    callsProjectCache = created.id;
    bb.log.info(`создан проект «Звонки» ${created.id}`);
    return created.id;
  };

  /** Спавн треда звонка: первая реплика владельца — prompt (контракт §6 п. 2). */
  const spawnCallThread = async (firstUtterance: string): Promise<string | null> => {
    try {
      const projectId = await ensureCallsProject();
      const now = new Date();
      const title = `📞 Звонок ${now.toLocaleDateString("ru-RU")} ${now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
      const thread = (await bb.sdk.threads.spawn({
        projectId,
        providerId: "live-call",
        model: "live",
        title,
        prompt: firstUtterance,
        environment: { type: "project-default" },
      } as never)) as unknown as { id: string };
      return thread?.id ?? null;
    } catch (e) {
      bb.log.warn(`spawn call thread failed: ${String(e)}`);
      return null;
    }
  };

  const threadManager = createCallThreadManager({
    sdk: bb.sdk,
    store,
    bridgeOwner,
    turnClosedWaiters,
    log: bb.log,
  });

  const advanceCallThread = threadManager.advanceCallThread;
  const sayCallThread = threadManager.sayCallThread;
  const endCallThread = threadManager.endCallThread;

  /** Обёртки для активной сессии; ссылка заполняется сразу после конструктора. */
  const sessionThreadHelpers = (sessionRef: { current: CallSession | null }) => ({
    spawnCallThread: async (firstUtterance: string) => spawnCallThread(firstUtterance),
    advanceCallThread: async (utterance: string) => {
      const t = sessionRef.current?.threadId;
      if (t && t !== sessionRef.current?.targetThreadId) {
        await advanceCallThread(t, utterance);
      }
    },
    sayCallThread: async (text: string) => {
      const t = sessionRef.current?.threadId;
      if (t && t !== sessionRef.current?.targetThreadId) {
        await sayCallThread(t, text);
      }
    },
    endCallThread: async (summary: string) => {
      const t = sessionRef.current?.threadId;
      if (t && t !== sessionRef.current?.targetThreadId) {
        await endCallThread(t, summary, sessionRef.current?.callId);
      }
    },
  });

  const startCall = async (sock: Sock, mode: "normal" | "extended", targetThreadId?: string): Promise<CallSession> => {
    const keys = await keysList();
    if (keys.length === 0) {
      const frame: ServerFrame = { type: "error", code: "no_keys", message: "нет ключей Gemini в настройках плагина", retryable: false };
      sock.send(JSON.stringify(frame));
      sock.close(BUSY_CLOSE_CODE, "no keys");
      throw new Error("no keys");
    }
    const cfg = await settings_get();
    const callId = `call_${Date.now().toString(36)}`;
    const sessionRef: { current: CallSession | null } = { current: null };
    const link = { sock };
    // Пока браузер отвалился, кадры некуда слать — молча отбрасываем, звонок живёт.
    const toBrowserRef = (f: ServerFrame) => {
      try {
        link.sock.send(JSON.stringify(f));
      } catch {
        // сокет закрыт
      }
    };
    const session = new CallSession({
      callId,
      keys,
      voice: str(cfg.voice, "Algenib"),
      languageCode: str(cfg.languageCode, "ru-RU"),
      thinkingLevel: ((str(cfg.extendedThinkingLevel, "LOW").toUpperCase() || "LOW") as "LOW" | "MEDIUM" | "HIGH"),
      mode,
      routerInput: str(cfg.routerInput, "text") === "audio" ? "audio" : "text",
      maxCallMinutes: Math.min(120, Math.max(5, num(cfg.maxCallMinutes, 60))),
      store,
      sdk: bb.sdk,
      targetThreadId,
      toBrowser: toBrowserRef,
      sendBrowserAudio: (turnSeq, pcm) => {
        try {
          link.sock.send(packFrame(FRAME_PLAYBACK, turnSeq, pcm));
        } catch {
          // браузер отвалился
        }
      },
      wsFactory: (url) => {
        bb.log.info(`gemini ws connect ${url.replace(/key=[^&]+/, "key=…")}`);
        const w = new WebSocket(url);
        w.addEventListener("open", () => bb.log.info("gemini ws open"));
        w.addEventListener("close", (ev) => bb.log.warn(`gemini ws close ${(ev as CloseEvent).code} ${(ev as CloseEvent).reason}`));
        w.addEventListener("error", () => bb.log.warn("gemini ws error"));
        (w as unknown as { _liveClientRef?: unknown });
        return w;
      },
      ...sessionThreadHelpers(sessionRef),
    });
    sessionRef.current = session;
    session.on("ended", () => {
      active = null;
    });
    active = { session, startedAt: Date.now(), link, detached: false, grace: null };
    await session.start();
    // Лимит минут: проверка раз в 30 с (спека §4).
    const interval = setInterval(() => {
      if (!active || active.session !== session) {
        clearInterval(interval);
        return;
      }
      session.checkTimeLimit();
    }, 30_000);
    // События наблюдаемых тредов: вброс в паузе (спека §4 EventBridge).
    const drain = setInterval(() => {
      if (!active || active.session !== session) {
        clearInterval(drain);
        return;
      }
      if (!eventBridge.canInject) return;
      const events = eventBridge.drain();
      for (const e of events) {
        toBrowserRef({ type: "event", kind: e.kind as "thread.idle" | "thread.failed" | "interaction.pending", threadId: e.threadId, summary: e.summary, queued: e.queued });
        session.injectWhenQuiet(`[СОБЫТИЕ] ${e.kind} ${e.threadId}: ${e.summary}`);
      }
    }, 1500);
    return session;
  };

  // Перезагрузка или выключение плагина: закрываем звонки в SQLite и останавливаем их треды в BB (контракт §13.2).
  try {
    void (async () => {
      const projId = await ensureCallsProject().catch(() => null);
      const stopped = await closeStaleCallThreads(store, bb.sdk, projId, bb.log);
      if (stopped.length > 0) {
        bb.log.warn(`closeStale: остановлено ${stopped.length} зависших тредов в BB: ${stopped.join(", ")}`);
      }
    })();
  } catch (e) {
    bb.log.warn(`closeStaleCallThreads: ${String(e)}`);
  }
  bb.onDispose(async () => {
    if (!active) return;
    // Браузеру «ended» не шлём: он переподключится, получит call_gone и сам начнёт
    // новый звонок — владелец остаётся на линии (приёмка 03.11: reload оборвал звонок).
    active.link.sock = { send() {}, close() {} } as unknown as Sock;
    await active.session.end("error").catch(() => {});
  });

  /** Один активный звонок на хост; второе подключение — busy + 4009 (контракт §2). */
  bb.http.experimental_websocket(
    "/call",
    () => {
      const state: { session: CallSession | null; helloTimer: NodeJS.Timeout | null } = { session: null, helloTimer: null };
      return {
        onOpen: (sock: Sock) => {
          if (active && !active.detached) {
            sock.send(JSON.stringify({ type: "error", code: "busy", message: "уже идёт звонок", retryable: false } satisfies ServerFrame));
            sock.close(BUSY_CLOSE_CODE, "busy");
            return;
          }
          state.helloTimer = setTimeout(() => {
            if (!state.session) sock.close(BUSY_CLOSE_CODE, "hello timeout");
          }, HELLO_TIMEOUT_MS);
        },
        onMessage: async (sock: Sock, data: string | Uint8Array) => {
          if (typeof data === "string") {
            let msg: unknown;
            try {
              msg = JSON.parse(data);
            } catch {
              return;
            }
            const parsed = clientFrame.safeParse(msg);
            if (!parsed.success) return;
            const frame = parsed.data;
            if (frame.type === "hello") {
              if (state.helloTimer) clearTimeout(state.helloTimer);
              const decision = decideHello(
                active ? { callId: active.session.callId, detached: active.detached } : null,
                frame.resume,
              );
              if (decision === "reattach" && active) {
                // Возврат после обрыва: тот же звонок, новые сокет и кадры. Так же — после
                // перезагрузки страницы (WebView на iOS): новый hello без resume подхватывает
                // ждущий звонок, а не получает busy.
                if (active.grace) clearTimeout(active.grace);
                active.grace = null;
                active.detached = false;
                active.link.sock = sock;
                state.session = active.session;
                bb.log.info(`браузер вернулся в звонок ${active.session.callId}${frame.resume ? "" : " (новая страница)"}`);
                store.event(active.session.callId, "client_log", { event: "reattached", detail: frame.resume ? "resume" : "new page" });
                active.session.resendReady();
                return;
              }
              if (decision === "gone") {
                sock.send(JSON.stringify({ type: "error", code: "call_gone", message: "звонок уже завершён", retryable: false } satisfies ServerFrame));
                sock.close(BUSY_CLOSE_CODE, "call gone");
                return;
              }
              if (decision === "busy") {
                sock.send(JSON.stringify({ type: "error", code: "busy", message: "уже идёт звонок", retryable: false } satisfies ServerFrame));
                sock.close(BUSY_CLOSE_CODE, "busy");
                return;
              }
              if (frame.threadId) {
                let targetThread: Record<string, unknown> | null = null;
                try {
                  const t = (await bb.sdk.threads.get({ threadId: frame.threadId })) as unknown as Record<string, unknown>;
                  if (t?.id) targetThread = t;
                } catch {
                  targetThread = null;
                }
                if (!targetThread) {
                  sock.send(JSON.stringify({
                    type: "error",
                    code: "thread_not_found",
                    message: `тред ${frame.threadId} не найден`,
                    retryable: false,
                  } satisfies ServerFrame));
                  sock.close(BUSY_CLOSE_CODE, "thread not found");
                  return;
                }
              }
              // Звонок по треду (§12.10) — строго normal (одна сессия gemini-3.8-live с инструментами).
              // Для общего звонка: Extended по умолчанию; «Быстрый» (normal) — если выбран явно.
              const fallback = str((await settings_get()).defaultMode, "extended") === "normal" ? "normal" : "extended";
              const callMode = frame.threadId ? "normal" : (frame.mode ?? fallback);
              try {
                state.session = await startCall(sock, callMode, frame.threadId);
              } catch {
                // Ошибка уже ушла фреймом и соединение закрыто.
              }
              return;
            }
            const s = state.session;
            if (!s) return;
            if (frame.type === "mute") s.setMuted(frame.muted);
            else if (frame.type === "playback_drained") s.onPlaybackDrained(frame.turnSeq);
            else if (frame.type === "switch_mode") {
              if (!s.targetThreadId) await s.switchMode(frame.mode);
            }
            else if (frame.type === "client_log") {
              bb.log.warn(`браузер: ${frame.event}${frame.detail ? ` — ${frame.detail}` : ""}`);
              store.event(state.session?.callId ?? "browser", "client_log", { event: frame.event, detail: frame.detail });
            }
            else if (frame.type === "text") s.sendUserMessage(frame.text);
            else if (frame.type === "confirm") s.decideConfirmation(frame.confirmationId, frame.decision);
            else if (frame.type === "end") await s.end("owner");
            return;
          }
          // Бинарный кадр: тип 0x01 — микрофон (контракт §2.1).
          try {
            const { type, pcm } = parseFrame(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
            if (type !== FRAME_MIC) return;
            state.session?.onBrowserAudio(pcm);
          } catch {
            // Мусорный кадр игнорируем: протокол требует строгого заголовка.
          }
        },
        onClose: (sock: Sock) => {
          if (state.helloTimer) clearTimeout(state.helloTimer);
          const s = state.session;
          if (!s || !active || active.session !== s || active.link.sock !== sock) return;
          // Обрыв браузера (мобильная сеть, Connect, свернули приложение): звонок не рвём,
          // ждём возврата 20 с — фронтенд переподключается сам с hello { resume }.
          active.detached = true;
          bb.log.warn(`браузер отвалился от звонка ${s.callId}, жду возврата ${REATTACH_GRACE_MS / 1000} с`);
          store.event(s.callId, "client_log", { event: "detached" });
          const a = active;
          a.grace = setTimeout(() => {
            if (active === a && a.detached) void s.end("error");
          }, REATTACH_GRACE_MS);
        },
      };
    },
    { auth: "local" },
  );

  /** Канал сервер ↔ мост (контракт §7). hello/own/turn от моста, say/end к мосту. */
  bb.http.experimental_websocket(
    "/bridge",
    () => ({
      onOpen: (sock: Sock) => {
        bridges.add(sock);
      },
      onMessage: (sock: Sock, data: string | Uint8Array) => {
        if (typeof data !== "string") return;
        let m: { type?: string; threadId?: string; pid?: number; text?: string };
        try {
          m = JSON.parse(data);
        } catch {
          return;
        }
        if (m.type === "hello") bb.log.info(`bridge hello pid=${m.pid}`);
        else if (m.type === "own" && m.threadId) {
          bridgeOwner.set(m.threadId, sock);
          bb.log.info(`bridge owns ${m.threadId}`);
        } else if (m.type === "turn" && m.threadId) {
          bb.log.info(`bridge turn on ${m.threadId}`);
        } else if (m.type === "turn_closed" && m.threadId) {
          turnClosedWaiters.get(m.threadId)?.();
          void threadManager.processAdvanceQueue(m.threadId);
        }
      },
      onClose: (sock: Sock) => {
        bridges.delete(sock);
        for (const [threadId, s] of bridgeOwner) if (s === sock) bridgeOwner.delete(threadId);
      },
    }),
    { auth: "local" },
  );

  /** Провайдер «Live Call», скрытый из выбора агентов (ADR-0007, спайк-проверено). */
  bb.providers.register({
    id: "live-call",
    displayName: "Live Call",
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["medium"],
    },
    composerActions: [],
    experimental_visibility: "installed",
    maintenance: { health: true },
  });

  /**
   * Треды звонков всегда прочитаны (решение владельца 02.11: не должны маячить).
   * Прочитанное отмечается при создании треда и после каждого завершённого хода.
   */
  const markCallThreadRead = async (threadId: string): Promise<void> => {
    try {
      await bb.sdk.threads.markRead({ threadId });
    } catch (e) {
      bb.log.warn(`markRead ${threadId} failed: ${String(e)}`);
    }
  };

  const isCallThread = async (threadId: string, projectId?: string): Promise<boolean> => {
    if (active?.session.threadId === threadId) return true;
    let pid = projectId;
    if (!pid) {
      try {
        const t = (await bb.sdk.threads.get({ threadId })) as unknown as { projectId?: string; providerId?: string };
        pid = t.projectId;
        if (t.providerId && t.providerId !== "live-call") return false;
      } catch {
        return false;
      }
    }
    if (!callsProjectCache) {
      const saved = str((await settings_get()).callsProjectId, "");
      callsProjectCache = saved || null;
    }
    return pid !== undefined && pid === callsProjectCache;
  };

  void (async () => {
    // Зачистка при загрузке: всё непрочитанное в проекте «Звонки» — прочитано.
    try {
      const saved = str((await settings_get()).callsProjectId, "");
      if (!saved) return;
      callsProjectCache = saved;
      const threads = (await bb.sdk.threads.list({ projectId: saved, limit: 100 }) as unknown as Array<{ id: string; lastReadAt: number | null; latestAttentionAt?: number }>) ?? [];
      for (const t of threads) {
        if (t.latestAttentionAt && (!t.lastReadAt || t.latestAttentionAt > t.lastReadAt)) {
          await markCallThreadRead(t.id);
        }
      }
    } catch (e) {
      bb.log.warn(`unread sweep failed: ${String(e)}`);
    }
  })();

  /** События BB: доклады о тредах и pending-вопросах (спека §4 EventBridge). */
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (active?.session && thread.id !== active.session.threadId) {
      eventBridge.onThreadIdle(thread.id, (lastAssistantText ?? "тред закончил").slice(0, 300));
    }
    void isCallThread(thread.id, thread.projectId).then(async (yes) => { if (yes) await markCallThreadRead(thread.id); });
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    if (active?.session && thread.id !== active.session.threadId) {
      eventBridge.onThreadFailed(thread.id, (error ?? "тред упал").slice(0, 300));
    }
    void isCallThread(thread.id, thread.projectId).then(async (yes) => { if (yes) await markCallThreadRead(thread.id); });
  });
  bb.events.on("thread.created", ({ thread }) => {
    void isCallThread(thread.id, thread.projectId).then(async (yes) => { if (yes) await markCallThreadRead(thread.id); });
  });
  bb.events.on("interaction.pending" as never, ((payload: { thread: { id: string; title?: string }; interaction: { payload?: Record<string, unknown>; kind?: string } }) => {
    const kind = payload.interaction?.payload?.kind === "approval" ? "permission" : "question";
    eventBridge.onInteractionPending(
      payload.thread.id,
      payload.thread.title ?? "",
      kind,
      String(payload.interaction?.payload?.prompt ?? payload.interaction?.payload?.reason ?? ""),
    );
  }) as never);

  /** RPC: статус и проба Extended (контракт §9). */
  bb.rpc.register(rpcContract, {
    status: async () => {
      const keys = await keysList();
      return {
        configured: keys.length > 0,
        keys: keys.length,
        activeCall: active
          ? {
              callId: active.session.callId,
              threadId: active.session.threadId,
              mode: active.session.mode,
              startedAt: active.startedAt,
            }
          : null,
      };
    },
    clientLog: async ({ event, detail }) => {
      bb.log.warn(`браузер (rpc): ${event}${detail ? ` — ${detail}` : ""}`);
      return { ok: true };
    },
    probe: async () => {
      const keys = await keysList();
      if (keys.length === 0) return { extendedNativeTools: false, checkedAt: new Date().toISOString(), detail: "нет ключей" };
      const result = await probeExtended(keys[0], bb);
      return { ...result, checkedAt: new Date().toISOString() };
    },
  });

  /** CLI: bb call status | calls | transcript | probe (контракт §9). */
  bb.cli.register({
    name: "call",
    summary: "Голосовые звонки live-call",
    commands: [
      { name: "status", summary: "Настроен ли плагин и идёт ли звонок", usage: "bb call status" },
      { name: "calls", summary: "Последние звонки", usage: "bb call calls [--limit N]" },
      { name: "transcript", summary: "Транскрипт звонка", usage: "bb call transcript <callId>" },
      { name: "probe", summary: "Доставляет ли Extended Thinking toolCall", usage: "bb call probe" },
      { name: "tool", summary: "Выполнить инструмент чтения без звонка (отладка данных)", usage: "bb call tool <имя> [json-аргументы]" },
    ],
    async run(argv) {
      const cmd = argv[0] ?? "status";
      if (cmd === "status") {
        const keys = await keysList();
        return {
          exitCode: 0,
          stdout: `ключи: ${keys.length}; звонок: ${active ? `активен (${active.session.mode})` : "нет"}; проект: ${str((await settings_get()).callsProjectId, "не создан")}\n`,
        };
      }
      if (cmd === "calls") {
        const rows = store.calls(20);
        return {
          exitCode: 0,
          stdout: rows.map((r) => `${r.id} ${new Date(r.startedAt).toISOString()} ${r.endReason ?? "идёт"}\n`).join("") || "нет звонков\n",
        };
      }
      if (cmd === "transcript") {
        const id = argv[1];
        if (!id) return { exitCode: 2, stdout: "usage: bb call transcript <callId>\n" };
        const rows = store.transcript(id);
        return {
          exitCode: 0,
          stdout: rows.map((r) => `${new Date(r.ts).toISOString()} [${r.kind}] ${r.payload.slice(0, 200)}\n`).join("") || "нет событий\n",
        };
      }
      if (cmd === "probe") {
        const keys = await keysList();
        if (keys.length === 0) return { exitCode: 1, stdout: "нет ключей\n" };
        const r = await probeExtended(keys[0], bb);
        return { exitCode: r.extendedNativeTools ? 0 : 1, stdout: `extendedNativeTools: ${r.extendedNativeTools}\n${r.detail ?? ""}\n` };
      }
      if (cmd === "tool") {
        // Только класс R: отладка того, что инструменты отдают модели. Записи — только в звонке через подтверждение.
        const def = toolByName(argv[1] ?? "");
        if (!def) return { exitCode: 2, stdout: "usage: bb call tool <имя> [json]\n" };
        if (def.cls !== "R") return { exitCode: 2, stdout: `${def.name} — класс ${def.cls}, вне звонка не выполняется\n` };
        let args: Record<string, unknown> = {};
        try {
          args = argv[2] ? (JSON.parse(argv.slice(2).join(" ")) as Record<string, unknown>) : {};
        } catch {
          return { exitCode: 2, stdout: "аргументы — JSON\n" };
        }
        const ctx = {
          sdk: bb.sdk,
          reportAction: () => {},
          callsProjectId: () => null,
          // только чтение: recall вне звонка показывает ту же память звонков, add здесь недостижим (класс C отклонён выше)
          voiceMemory: { add: () => ({ id: 0, duplicate: true }), list: () => store.listMemory() },
        } as unknown as Parameters<typeof def.execute>[1];
        const result = await def.execute(args, ctx);
        return { exitCode: result.ok ? 0 : 1, stdout: JSON.stringify(result, null, 1).slice(0, 8000) + "\n" };
      }
      return { exitCode: 2, stdout: "usage: bb call status|calls|transcript <callId>|probe\n" };
    },
  });
}

/**
 * Проба `bb call probe`: одна сессия Extended с объявленным NON_BLOCKING
 * инструментом; toolCall за 30 с — значит Google починил, режим можно менять
 * в настройках (спека §6 CLI). Режимы сама не меняет.
 */
async function probeExtended(key: string, bb: BbPluginApi): Promise<{ extendedNativeTools: boolean; detail?: string }> {
  const client = new LiveClient({
    key,
    model: "gemini-3.8-live-extended-thinking",
    voice: "Algenib",
    languageCode: "ru-RU",
    systemInstruction: "Ты проверочный агент. При любом сообщении вызови инструмент probe_tool.",
    thinkingLevel: "LOW",
    tools: [{ functionDeclarations: [{ name: "probe_tool", description: "пробный инструмент", behavior: "NON_BLOCKING", parameters: { type: "object", properties: {} } }] }],
  });
  let got = false;
  client.on("toolCall", () => {
    got = true;
  });
  return await new Promise((resolve) => {
    const finish = (detail: string) => {
      client.close();
      resolve({ extendedNativeTools: got, detail });
    };
    client.on("close", (code) => finish(`соединение закрыто (${code})`));
    client.on("setupComplete", () => client.sendClientContent("Вызови probe_tool.", true));
    const timer = setTimeout(() => finish(got ? "toolCall получен" : "toolCall не пришёл за 30 с"), 30_000);
    timer.unref?.();
    client.connect();
    void bb;
  });
}

/** Хеш аргументов доступен и серверу — для журналов вердиктов (контракт §5). */
export { argsHash };
