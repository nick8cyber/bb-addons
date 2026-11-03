/**
 * CallSession: одна сессия звонка (спека §4). Маршрутизирует аудио и события между
 * браузером, Gemini Live, инструментами и тредом звонка. Два режима:
 * normal — одна сессия с нативными инструментами; extended — VOICE без инструментов
 * + ROUTER на gemini-3.8-live, который выбирает инструменты (ADR-0006).
 */
import { EventEmitter } from "node:events";
import {
  BYTES_PER_SECOND_24K,
  MIC_FRAME_BYTES,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "./contract.js";
import { ConfirmationGate, argsHash, type PendingConfirmation } from "./confirmation-gate.js";
import { ContextLedger } from "./context-ledger.js";
import { KeyPool, QuotaExhaustedError } from "./key-pool.js";
import { LiveClient } from "./live-client.js";
import { EMPTY_CONTEXT, routerInstruction, threadRouterInstruction, threadVoiceInstruction, voiceInstructionExtended, voiceInstructionNormal, type PromptContext } from "./prompt.js";
import { TOOLS, capabilityList, nativeDeclarations, runToolCall, toolByName } from "./tools.js";
import type { ToolClass, ToolResult } from "./contract.js";
import type { CallStore } from "./call-store.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ToolContext } from "./tools.js";
import { fetchThreadMessages, formatMessageTime, formatThreadMessagesBlock, type ThreadMessage } from "./thread-messages.js";
import { BrainCenter } from "./brain-center.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CallState =
  | "connecting" | "listening" | "thinking" | "speaking" | "working" | "reconnecting" | "muted" | "ended";

export interface CallSessionDeps {
  callId: string;
  keys: string[];
  voice: string;
  languageCode: string;
  thinkingLevel: "LOW" | "MEDIUM" | "HIGH";
  mode: "normal" | "extended";
  /** Extended отключён в проде (ADR-0006, пересмотр 2); true — только для тестов старого пути. */
  allowExtended?: boolean;
  /** Вход маршрутизатора: text — из транскрипта VOICE, audio — то же аудио в обе сессии. */
  routerInput: "text" | "audio";
  maxCallMinutes: number;
  store: CallStore;
  sdk: BbPluginApi["sdk"];
  /** Отправка JSON-кадра и аудио в браузер. */
  toBrowser: (frame: ServerFrame) => void;
  sendBrowserAudio: (turnSeq: number, pcm: Uint8Array) => void;
  /** Тред звонка: спавн первой репликой, реплики, реплики агента, итог. */
  spawnCallThread: (firstUtterance: string) => Promise<string | null>;
  advanceCallThread: (utterance: string) => Promise<void>;
  sayCallThread: (text: string) => Promise<void>;
  endCallThread: (summary: string) => Promise<void>;
  wsFactory?: (url: string) => WebSocket;
  targetThreadId?: string;
  storageDir?: string;
  log?: { info(s: string): void; warn(s: string): void; error(s: string): void };
}

const COMPRESSION = { triggerTokens: 20000, targetTokens: 10000 };

export class CallSession extends EventEmitter {
  state: CallState = "connecting";
  mode: "normal" | "extended";
  threadId: string | null = null;
  readonly targetThreadId: string | null = null;
  private threadMessages: ThreadMessage[] = [];
  private threadMeta: {
    id: string;
    title: string;
    project?: string;
    state?: string;
    providerId?: string;
    model?: string;
  } | null = null;
  private threadState: {
    status: string;
    lastMessageTime?: string;
    lastOwnerMessageIndex?: number;
    lastAgentMessageIndex?: number;
  } = { status: "свободен" };
  private nowUtc = "";
  private threadMessagesBlock = "";
  private voice: LiveClient | null = null;
  private router: LiveClient | null = null;
  private pool: KeyPool;
  private gate: ConfirmationGate;
  private ledger = new ContextLedger();
  private muted = false;
  private ended = false;
  private startedAt = Date.now();
  private modeHistory: string[];
  private lastVoiceLine = "";
  /** Накопленные результаты инструментов одной реплики: уходит в VOICE одним пакетом. */
  private systemBatch: string[] = [];
  /** Голос сейчас генерирует ответ: вставка с turnComplete=true оборвала бы его на полуслове. */
  private voiceTalking = false;
  private quietQueue: string[] = [];
  private systemBatchTimer: NodeJS.Timeout | null = null;
  private routerBusyCount = 0;
  private pendingToolResponses = new Map<string, { functionId?: string; def: string; args: Record<string, unknown> }>();
  private tpmWarned = false;
  /** Приветствие один раз за звонок, независимо от переподключений. */
  private greeted = false;
  /** Момент последней законченной реплики агента — окно фильтра эха (3 с). */
  private lastAgentLineAt = 0;
  /** Диагностика микрофона: байты и пиковая амплитуда за отчётный интервал. */
  private micBytes = 0;
  private micPeak = 0;
  private micReporter: NodeJS.Timeout | null = null;
  /** Сборка реплики владельца из кусков inputTranscription; конец — 700 мс тишины. */
  private ownerUtterance: { text: string; firstAt: number; lastAt: number } | null = null;
  private ownerUtteranceTimer: NodeJS.Timeout | null = null;
  /** Мозговой центр звонка по треду (§12.11). */
  brain: BrainCenter | null = null;
  brainSummary: string | null = null;
  /** Последний упавший инструмент (§12.12 п. 3: запрет молчаливого повтора). */
  private lastFailedTool: string | null = null;
  /** Счётчик вызовов инструментов в текущем ходе владельца (§12.12 п. 4). */
  private toolCallsInCurrentTurn = 0;

  constructor(private deps: CallSessionDeps) {
    super();
    this.targetThreadId = deps.targetThreadId ?? null;
    // Extended отключён (ADR-0006, пересмотр 2): без allowExtended любой звонок — normal.
    this.mode = this.targetThreadId || (deps.mode === "extended" && !deps.allowExtended) ? "normal" : deps.mode;
    this.modeHistory = [this.mode];
    this.pool = new KeyPool(deps.keys, {
      onWarning: (m) => this.frame({ type: "warning", code: "tpm_near_limit", message: m }),
      onKeySwitch: (active, of, reason) => {
        this.frame({ type: "key", active, of, reason });
        this.deps.store.incKeySwitches(this.deps.callId);
      },
    });
    this.gate = new ConfirmationGate(
      {
        refuse: ["нет", "не", "отмена", "отмени", "отбой", "стоп", "подожди", "погоди", "потом", "но"],
        confirm: ["да", "давай", "подтверждаю", "отправляй", "ок", "окей", "верно"],
        permit: ["разрешаю", "разреши", "одобряю"],
        launch: ["запускай", "запусти", "запускаем", "раздавай", "раздай"],
        toolExtra: ["останавливай"],
      },
      undefined,
      {
        onConfirmationUpdate: (p, phase) => this.onConfirmationUpdate(p, phase),
        onVerdict: (p, verdict) => void this.onVerdict(p, verdict),
      },
    );
  }

  private frame(f: ServerFrame) {
    this.deps.toBrowser(f);
  }

  private setState(s: CallState, detail?: string) {
    if (this.ended && s !== "ended") return;
    this.state = s;
    this.frame({ type: "state", state: s, detail });
  }

  /** Браузер вернулся после обрыва WS: повторить ready, тред и состояние (сессии Gemini живы). */
  resendReady() {
    if (this.ended) return;
    this.frame({
      type: "ready",
      callId: this.deps.callId,
      mode: this.mode,
      voice: this.deps.voice,
      keys: { active: this.pool.active, of: this.pool.of },
      targetThreadId: this.targetThreadId ?? undefined,
    });
    if (this.threadId) this.frame({ type: "thread", threadId: this.threadId });
    this.setState(this.muted ? "muted" : "listening");
  }

  private promptContext: PromptContext = EMPTY_CONTEXT;

  /** Контекст для инструкций: проекты BB, умения, своя память — из реальных данных на старте звонка. */
  private async buildPromptContext(): Promise<PromptContext> {
    let projects: string[] = [];
    try {
      const list = (await Promise.race([
        this.deps.sdk.projects.list() as Promise<Array<Record<string, unknown>>>,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
      ])) as Array<Record<string, unknown>>;
      projects = (Array.isArray(list) ? list : []).map((p) => String(p.name ?? "")).filter((n) => n && n !== "Звонки");
    } catch {
      projects = [];
    }
    let memory: string[] = [];
    try {
      memory = this.deps.store.listMemory(40).map((m) => m.text).reverse();
    } catch {
      memory = [];
    }
    return { projects, capabilities: capabilityList(this.targetThreadId ?? undefined), memory, mode: this.mode };
  }

  async start() {
    if (this.targetThreadId) {
      this.deps.store.startCall(this.deps.callId);
      this.deps.store.event(this.deps.callId, "call_started", { targetThreadId: this.targetThreadId });
      this.nowUtc = new Date().toISOString();
      let envObj: Record<string, unknown> = {};
      let targetProjectId = "";
      try {
        const raw = (await this.deps.sdk.threads.get({ threadId: this.targetThreadId })) as unknown as Record<string, unknown>;
        const t = (raw && typeof raw === "object" && "thread" in raw && raw.thread ? raw.thread : raw) as Record<string, unknown>;
        envObj = (raw && typeof raw === "object" && "environment" in raw && raw.environment ? raw.environment : {}) as Record<string, unknown>;
        targetProjectId = String(t?.projectId ?? envObj?.projectId ?? "");
        // Тред хранит только environmentId; isGitRepo / branchName / hostId — в самом окружении (§12.11 п.1, приёмка 03.11).
        const envId = t?.environmentId ? String(t.environmentId) : "";
        if (envId && envObj.isGitRepo === undefined) {
          try {
            const er = (await (this.deps.sdk as unknown as { environments: { get(a: { environmentId: string }): Promise<unknown> } }).environments.get({ environmentId: envId })) as Record<string, unknown>;
            const e = (er && typeof er === "object" && "environment" in er && er.environment ? er.environment : er) as Record<string, unknown>;
            if (e && typeof e === "object") envObj = { ...e, ...envObj };
          } catch {
            /* окружение недоступно — мозговой центр не получит worktree и не запустится */
          }
        }
        let projectTitle: string | undefined = undefined;
        if (targetProjectId) {
          try {
            const projects = ((await this.deps.sdk.projects.list() as unknown) ?? []) as Array<Record<string, unknown>>;
            const p = projects.find((x) => String(x.id) === targetProjectId);
            projectTitle = p?.name ? String(p.name) : targetProjectId;
          } catch {
            projectTitle = targetProjectId;
          }
        }
        let stateStr = "свободен";
        if (t?.hasPendingInteraction) stateStr = "ждёт тебя";
        else if (t?.status === "active") stateStr = "работает";
        else if (t?.status === "error") stateStr = "ошибка";

        this.threadMeta = {
          id: this.targetThreadId,
          title: String(t?.title ?? t?.id ?? "Тред"),
          project: projectTitle,
          state: stateStr,
          providerId: t?.providerId ? String(t.providerId) : undefined,
          model: (t?.model ?? (t?.runtime as Record<string, unknown>)?.model) ? String(t?.model ?? (t?.runtime as Record<string, unknown>)?.model) : undefined,
        };
      } catch {
        this.threadMeta = { id: this.targetThreadId, title: "Тред" };
      }

      this.threadMessages = await fetchThreadMessages(this.deps.sdk, this.targetThreadId);
      const formatted = formatThreadMessagesBlock(this.threadMessages);
      this.threadMessagesBlock = formatted.block;

      let lastOwnerIndex: number | undefined;
      let lastAgentIndex: number | undefined;
      for (const m of this.threadMessages) {
        if (m.role === "owner") lastOwnerIndex = m.number;
        else if (m.role === "agent") lastAgentIndex = m.number;
      }
      const lastMsg = this.threadMessages[this.threadMessages.length - 1];
      this.threadState = {
        status: this.threadMeta?.state ?? "свободен",
        lastMessageTime: lastMsg ? formatMessageTime(lastMsg.createdAt) : undefined,
        lastOwnerMessageIndex: lastOwnerIndex,
        lastAgentMessageIndex: lastAgentIndex,
      };

      this.deps.store.event(this.deps.callId, "thread_context", {
        messages: formatted.messagesCount,
        skipped: formatted.skippedCount,
        chars: formatted.chars,
      });

      this.brain = new BrainCenter({
        sdk: this.deps.sdk,
        store: this.deps.store,
        callId: this.deps.callId,
        targetThreadId: this.targetThreadId,
        targetThreadTitle: this.threadMeta?.title ?? "Тред",
        targetProjectId,
        targetHostId: envObj.hostId ? String(envObj.hostId) : undefined,
        targetBranchName: envObj.branchName ? String(envObj.branchName) : undefined,
        isGitRepo: Boolean(envObj.isGitRepo),
        allMessages: this.threadMessages,
        storageDir: this.deps.storageDir ?? join(tmpdir(), "bb-live-call-brain"),
        log: this.deps.log,
      });

      this.brain.onSummaryReady = (summaryText, ms) => {
        this.brainSummary = summaryText;
        this.voice?.sendClientContent(
          `[СИСТЕМА] Мозговой центр подготовил сводку по треду (${ms} мс):\n${summaryText}\n\nСейчас же перескажи эту сводку владельцу своими словами: цель треда, что сделано, на чём остановились, что ждёт владельца, открытые вопросы.`,
          true,
        );
      };

      this.brain.onSummaryTimeout = () => {
        this.voice?.sendClientContent(
          `[СИСТЕМА] Сводка мозгового центра не успела сформироваться за 60 секунд. Скажи владельцу: «Сводка не успела подготовиться вовремя, ориентируюсь по сообщениям треда» и продолжай разговор по сообщениям треда.`,
          true,
        );
      };

      void this.brain.start().then((id) => {
        if (id) return;
        // Мозговой центр не запустился (не-git проект или worktree не создался, §12.11 п.1):
        // инструменты получают brain=null, голос не ждёт сводку и работает по сообщениям треда.
        this.brain = null;
        if (this.greeted) {
          this.voice?.sendClientContent(
            "[СИСТЕМА] Мозговой центр в этом звонке недоступен. Скажи владельцу об этом одной фразой и сразу коротко расскажи, что сейчас происходит в треде, по сообщениям треда.",
            true,
          );
        }
      });
    } else {
      this.deps.store.startCall(this.deps.callId);
    }

    this.promptContext = await this.buildPromptContext();
    this.deps.store.setModeHistory(this.deps.callId, this.modeHistory);
    try {
      await this.openSessions();
    } catch (e) {
      this.frame({ type: "error", code: "no_keys", message: String(e), retryable: false });
      return this.end("error");
    }
    this.frame({
      type: "ready",
      callId: this.deps.callId,
      mode: this.mode,
      voice: this.deps.voice,
      keys: { active: this.pool.active, of: this.pool.of },
      targetThreadId: this.targetThreadId ?? undefined,
    });
    if (this.threadId) {
      this.frame({ type: "thread", threadId: this.threadId });
    }
    this.setState("listening");
    this.gateTicker();
  }

  private gateTicker() {
    if (this.ended) return;
    this.gate.tick();
    setTimeout(() => this.gateTicker(), 1000);
  }

  private async openSessions(handle?: string) {
    // Прежние сессии закрываются ВСЕГДА: раньше в Extended новый помощник поднимался
    // поверх старого, а старый оставался открытым у Google, пока тот не закрывал его
    // по тайм-ауту («1011 Deadline expired», приёмка 03.11) — и держал лимит ключа.
    this.closeSessions();
    if (this.mode === "normal") {
      this.voice = this.makeVoiceSession(handle);
    } else {
      if (this.pool.count < 2) {
        // Фоллбэк: extended требует двух ключей (контракт §1).
        this.frame({ type: "warning", code: "extended_unavailable", message: "Extended требует два ключа, работаю в режиме «Быстрый»" });
        this.mode = "normal";
        this.modeHistory.push("normal");
        this.deps.store.setModeHistory(this.deps.callId, this.modeHistory);
        this.voice = this.makeVoiceSession(handle);
        this.frame({ type: "mode", mode: "normal", switching: false });
        return;
      }
      this.voice = this.makeVoiceSession(handle);
      this.router = this.makeRouterSession();
    }
  }

  /** Закрыть голос и помощника; закрытие заменённой сессии не вызывает переподключение. */
  private closeSessions() {
    const voice = this.voice;
    const router = this.router;
    this.voice = null;
    this.router = null;
    voice?.close();
    router?.close();
  }

  /** Сколько сессий Gemini открыто у звонка (для тестов на утечки). */
  openSessionCount(): number {
    return (this.voice ? 1 : 0) + (this.router ? 1 : 0);
  }

  private makeVoiceSession(handle?: string): LiveClient {
    this.voiceTalking = false;
    const systemInstruction = this.targetThreadId
      ? threadVoiceInstruction({
          thread: this.threadMeta ?? { id: this.targetThreadId, title: "Тред" },
          nowUtc: this.nowUtc,
          threadState: this.threadState,
          messagesBlock: this.threadMessagesBlock,
          memory: this.promptContext.memory,
          brainSummary: this.brainSummary ?? undefined,
        })
      : this.mode === "normal"
        ? voiceInstructionNormal(this.promptContext)
        : voiceInstructionExtended(this.promptContext);

    const client = new LiveClient({
      key: this.pool.activeKey,
      model: this.mode === "normal" ? "gemini-3.8-live" : "gemini-3.8-live-extended-thinking",
      voice: this.deps.voice,
      languageCode: this.deps.languageCode,
      systemInstruction,
      thinkingLevel: this.mode === "normal" ? undefined : this.deps.thinkingLevel,
      tools: this.mode === "normal" ? (nativeDeclarations(this.targetThreadId ?? undefined) as unknown[]) : undefined,
      sessionHandle: handle,
      contextWindowCompression: COMPRESSION,
      wsFactory: this.deps.wsFactory,
    });
    this.wireVoice(client);
    client.connect();
    return client;
  }

  private makeRouterSession(): LiveClient {
    let messagesInfo: { firstRange?: string; lastRange?: string; total: number } | undefined;
    if (this.threadMessages.length > 0) {
      const total = this.threadMessages.length;
      if (total > 30) {
        const k = total - 19;
        messagesInfo = {
          firstRange: "1–10",
          lastRange: `${k}–${total}`,
          total,
        };
      } else {
        messagesInfo = {
          firstRange: `1–${total}`,
          total,
        };
      }
    }

    const systemInstruction = this.targetThreadId
      ? threadRouterInstruction({
          thread: this.threadMeta ?? { id: this.targetThreadId, title: "Тред" },
          messagesInfo,
        })
      : routerInstruction(this.promptContext);

    const client = new LiveClient({
      key: this.pool.key(1),
      model: "gemini-3.8-live",
      voice: this.deps.voice,
      languageCode: this.deps.languageCode,
      systemInstruction,
      tools: nativeDeclarations(this.targetThreadId ?? undefined) as unknown[],
      contextWindowCompression: COMPRESSION,
      wsFactory: this.deps.wsFactory,
    });
    this.wireRouter(client);
    client.connect();
    return client;
  }

  private toolContext(): ToolContext {
    return {
      sdk: this.deps.sdk,
      gate: this.gate,
      ledger: this.ledger,
      targetThreadId: this.targetThreadId ?? undefined,
      threadMessages: this.threadMessages,
      brain: this.brain ?? undefined,
      isTargetThreadActive: async () => {
        if (!this.targetThreadId) return false;
        const res = (await this.deps.sdk.threads.get({ threadId: this.targetThreadId }).catch(() => null)) as unknown as {
          thread?: { status?: string };
          status?: string;
        } | null;
        const st = res?.thread?.status ?? res?.status;
        return st === "active";
      },
      newActionId: (tool: string) => this.newActionId(tool),
      voiceMemory: {
        add: (text: string) => this.deps.store.addMemory(text),
        list: () => this.deps.store.listMemory(),
      },
      reportAction: (tool: string, cls: ToolClass, status: "running" | "done" | "failed" | "cancelled", summary: string, threadId?: string, actionId?: string) => {
        this.frame({
          type: "action",
          actionId: actionId ?? this.newActionId(tool),
          tool,
          class: cls,
          status,
          summary,
          threadId,
        });
        this.deps.store.event(this.deps.callId, "action", { tool, cls, status, summary, threadId });
        if (tool === "end_call" && status === "done") void this.end("owner");
        if (tool === "switch_mode" && status === "running") void this.switchMode(summary === "extended" ? "extended" : "normal", "tool");
      },
      callsProjectId: () => null,
      rememberArgs: (hash: string, args: Record<string, unknown>) => {
        this.storedArgs.set(hash, args);
      },
    } as unknown as ToolContext;
  }

  private wireVoice(client: LiveClient) {
    const ctx = this.toolContext();
    client.on("setupComplete", () => {
      if (this.greeted) return; // после переподключений приветствие не повторяем
      this.greeted = true;
      if (this.targetThreadId) {
        // §12.11 п. 3: Голос сразу представляется: «Привет, сейчас обрабатываю информацию по треду».
        if (this.brain) {
          client.sendClientContent("Система: звонок начат. Скажи: «Привет, сейчас обрабатываю информацию по треду». Больше ничего не добавляй.", true);
        } else {
          client.sendClientContent("Система: звонок начат. Мозговой центр недоступен. Скажи «Привет» и сразу коротко расскажи, что сейчас происходит в треде, по сообщениям треда.", true);
        }
      } else {
        // Модель молчит до первого слова владельца: любая просьба «поздоровайся»
        // приводила к тому, что она сама запускала обзор поверх владельца (02.11).
        // turnComplete: false — контекст получен, ответа не требуется.
        client.sendClientContent("Система: звонок начат. Жди первого слова владельца и отвечай только ему.", false);
      }
    });
    client.on("audio", (turnSeq: number, pcm: Uint8Array) => {
      this.gate.onModelAudio(turnSeq, pcm.length);
      if (pcm.length > 0) {
        if (this.turnAudioBytes === 0) this.turnFirstAudioAt = Date.now();
        this.turnAudioBytes += pcm.length;
        this.lastAudioTurnSeq = turnSeq;
      }
      if (pcm.length > 0) this.deps.sendBrowserAudio(turnSeq, pcm);
      if (pcm.length > 0) this.voiceTalking = true;
      if (this.state !== "speaking" && pcm.length > 0) this.setState("speaking");
    });
    client.on("interrupted", (turnSeq: number | null) => {
      this.voiceTalking = false;
      this.frame({ type: "interrupted", turnSeq: turnSeq ?? 0 });
      this.turnAudioBytes = 0;
      if (this.listenFallback) { clearTimeout(this.listenFallback); this.listenFallback = null; }
      this.setState("listening");
    });
    let agentBuf = "";
    client.on("outputTranscript", (text: string) => {
      if (!text) return;
      // Транскрипт приходит и кусками, и кумулятивно в аудио-сообщениях:
      // кумулятивный кусок, начинающийся с накопленного, ЗАМЕНЯЕТ его, а не дублирует.
      if (text.startsWith(agentBuf) && agentBuf.length > 0) agentBuf = text;
      else if (agentBuf.startsWith(text)) return; // кусок уже внутри накопленного
      else agentBuf += text;
      this.frame({ type: "transcript", role: "agent", text, final: false });
    });
    client.on("turnComplete", () => {
      this.voiceTalking = false;
      // Аудит PLUG-108: состояние оставалось «speaking» до конца звонка — речь владельца уходила ×0.25.
      // Но снимать приглушение по turnComplete рано: браузер ещё доигрывает звук, эхо пошло бы в Gemini.
      // Поэтому: нет звука в ходе (текст) — сразу; есть — по playback_drained, запасной таймер по длине звука.
      this.scheduleListenAfterPlayback();
      this.flushQuietQueue();
      void (async () => {
        // Сначала тред: иначе первая же реплика агента уйдёт в say до его создания и потеряется.
        await this.maybeSpawnThreadOnFirstUtterance();
        const line = agentBuf.trim();
        agentBuf = "";
        this.reconnectAttempts = 0;
        if (!line) return;
        this.frame({ type: "transcript", role: "agent", text: line, final: true });
        this.lastVoiceLine = line.slice(0, 300);
        this.ledger.add("agent", line);
        this.deps.store.event(this.deps.callId, "agent_line", { text: line });
        this.lastAgentLineAt = Date.now();
        await this.deps.sayCallThread(line);
      })();
    });
    client.on("inputTranscript", (text: string) => {
      if (!this.gate.isMicOpen()) return;
      this.frame({ type: "transcript", role: "owner", text, final: false });
      this.gate.onOwnerTranscriptChunk(text);
      const now = Date.now();
      if (!this.ownerUtterance) this.ownerUtterance = { text, firstAt: now, lastAt: now };
      else {
        this.ownerUtterance.text += text;
        this.ownerUtterance.lastAt = now;
      }
      if (this.ownerUtteranceTimer) clearTimeout(this.ownerUtteranceTimer);
      this.ownerUtteranceTimer = setTimeout(() => this.finalizeOwnerUtterance(), 700);
    });
    client.on("toolCall", (calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>) => {
      if (this.mode !== "normal") return; // Extended инструментов не имеет; на всякий случай игнор.
      void this.handleNativeCalls(client, calls);
    });
    client.on("goAway", (timeLeft: number) => {
      void this.reconnectVoice(timeLeft);
    });
    client.on("usage", (promptTokens: number) => {
      this.pool.addUsage(promptTokens);
    });
    client.on("close", (code: number, reason: string) => {
      // Сессию закрыли мы сами (смена режима или ключа) — её закрытие не повод переподключаться.
      if (this.ended || this.voice !== client) return;
      const text = reason ?? "";
      // Gemini отдаёт квоту по-разному: 429, RESOURCE_EXHAUSTED, 1011 "Resource has been exhausted".
      if (String(code) === "429" || /exhausted|quota/i.test(text)) {
        this.switchKeyOnQuota("quota");
        return;
      }
      if (code === 1007) {
        // Google отверг настройку сессии — переподключение с тем же setup бессмысленно.
        bb_log(this.deps, `gemini отверг setup: ${text.slice(0, 160)}`);
        this.frame({ type: "error", code: this.mode === "extended" ? "extended_unavailable" : "internal", message: `Google отверг настройку сессии: ${text.slice(0, 120)}`, retryable: false });
        if (this.mode === "extended") return;
        void this.end("error");
        return;
      }
      if (code === 1008) {
        // "session not found": handle мёртв (привязан к умершей сессии/ключу).
        // Пересоздаём БЕЗ handle с пересказом; при повторе — смена ключа.
        this.reconnect1008 += 1;
        if (this.reconnect1008 >= 2) {
          this.reconnect1008 = 0;
          this.switchKeyOnQuota("unavailable");
          return;
        }
        void this.reconnectVoice(0.2, undefined);
        return;
      }
      void this.reconnectVoice(2);
    });
    client.on("error", (message: string) => {
      this.frame({ type: "error", code: "google_unreachable", message, retryable: true });
    });
    client.on("sendDropped", () => {
      // Кадры при мёртвом сокете — ожидаемо во время переподключения, не спамим.
    });
    void ctx;
  }

  /** Число вызовов инструментов в текущем ходе владельца (защита от циклов). */
  private toolCallsThisTurn = 0;

  /** native: вызовы инструментов голосовой сессией. */
  private async handleNativeCalls(client: LiveClient, calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>) {
    this.setState("working");
    for (const call of calls) {
      if (this.lastFailedTool === call.name) {
        // §12.12 п. 3: Запрет повторного вызова того же инструмента после ok:false без реплики владельца
        client.sendToolResponse(
          call.id,
          { ok: false, error: "сначала сообщи владельцу" },
          "WHEN_IDLE",
          call.name,
        );
        continue;
      }
      const def = toolByName(call.name, this.targetThreadId ?? undefined);
      if (!def) {
        client.sendToolResponse(call.id, { error: `неизвестный инструмент ${call.name}` }, "WHEN_IDLE", call.name);
        continue;
      }
      if (this.toolCallsThisTurn >= 6) {
        client.sendToolResponse(call.id, { error: "слишком много вызовов подряд: ответь владельцу тем, что уже известно" }, "WHEN_IDLE", call.name);
        continue;
      }
      this.toolCallsThisTurn += 1;
      const { result } = await runToolCall(def, call.args, call.id, this.toolContext());
      // Голосовая сессия должна отреагировать на результат: WHEN_IDLE (SILENT запрещает ответ).
      client.sendToolResponse(call.id, result, "WHEN_IDLE", call.name);
      if (!result.ok && "error" in result) {
        this.lastFailedTool = call.name;
        this.deps.store.event(this.deps.callId, "tool_error", { tool: def.name, args: call.args, code: result.error.code, message: result.error.message.slice(0, 300) });
      } else if (result.ok) {
        this.lastFailedTool = null;
      }
      if (def.cls !== "R") this.deps.store.event(this.deps.callId, "confirm", { tool: def.name });
    }
    this.setState("listening");
  }

  private wireRouter(client: LiveClient) {
    const ctx = this.toolContext();
    client.on("setupComplete", () => {
      this.routerReconnects = 0;
    });
    client.on("toolCall", (calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>) => {
      void this.handleRouterCalls(client, calls);
    });
    client.on("usage", (tokens: number) => this.pool.addUsage(tokens));
    client.on("close", (code: number, reason?: string) => {
      if (this.ended || this.router !== client) return;
      this.router = null;
      // Квота ключа ROUTER (429 или 1011 «exceeded your current quota»): у Extended
      // второго ключа больше нет — честно говорим и предлагаем Быстрый, а не долбим Google
      // переподключениями без паузы (было: 6 попыток за 0,4 с, приёмка 02.11).
      if (String(code) === "429" || /exhausted|quota/i.test(reason ?? "")) {
        this.frame({
          type: "warning",
          code: "extended_unavailable",
          message: "Extended недоступен: второй ключ упёрся в квоту. Переключись на Быстрый.",
        });
        return;
      }
      this.routerReconnects += 1;
      if (this.routerReconnects > 5) {
        this.frame({ type: "warning", code: "extended_unavailable", message: "Помощник Extended не подключается. Переключись на Быстрый." });
        return;
      }
      const wait = Math.min(500 * 2 ** this.routerReconnects, 10_000);
      setTimeout(() => {
        if (!this.ended && this.mode === "extended" && !this.router) this.router = this.makeRouterSession();
      }, wait);
    });
    void ctx;
  }

  /**
   * ROUTER выбрал инструменты. Результаты копятся в systemBatch и уходят в VOICE
   * одним пакетом [СИСТЕМА] после 300 мс тишины (спека §2.1, пакетная вставка).
   * Повторы отбрасываются, ≤3 вызова на реплику.
   */
  private async handleRouterCalls(client: LiveClient, calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>) {
    if (this.routerBusyCount >= 3) {
      for (const c of calls) client.sendToolResponse(c.id, { error: "превышен лимит вызовов на реплику" }, "SILENT", c.name);
      return;
    }
    this.routerBusyCount += 1;
    this.setState("working");
    const seen = new Map<string, boolean>();
    for (const call of calls) {
      const def = toolByName(call.name, this.targetThreadId ?? undefined);
      if (!def) {
        client.sendToolResponse(call.id, { error: `неизвестный инструмент ${call.name}` }, "SILENT", call.name);
        continue;
      }
      const hash = argsHash(def.name, call.args);
      if (seen.has(hash)) {
        client.sendToolResponse(call.id, { info: "уже выполнено, больше не вызывай" }, "SILENT", call.name);
        continue;
      }
      seen.set(hash, true);
      if (def.cls === "R") {
        const { result } = await runToolCall(def, call.args, call.id, this.toolContext());
        client.sendToolResponse(call.id, result, "SILENT", call.name);
        this.enqueueSystem(def.name, result);
      } else {
        // Запись: toolResponse откладывается до вердикта (спека §2.1 п. 4).
        this.pendingToolResponses.set(hash, { functionId: call.id, def: def.name, args: call.args });
        const { result } = await runToolCall(def, call.args, call.id, this.toolContext());
        void result; // needsConfirmation уже вставлен в VOICE через gate events.
      }
    }
    this.flushSystemSoon();
    setTimeout(() => {
      this.routerBusyCount = Math.max(0, this.routerBusyCount - 1);
    }, 3000);
  }

  /** Результат R-инструментов: один пакет [СИСТЕМА] в VOICE. */
  private enqueueSystem(tool: string, result: ToolResult) {
    const text = result.ok ? JSON.stringify(result.data) : `ошибка: ${"error" in result ? result.error.message : "нужно подтверждение"}`;
    this.systemBatch.push(`инструмент ${tool}: ${text}`);
    if (this.systemBatchTimer) clearTimeout(this.systemBatchTimer);
    this.systemBatchTimer = setTimeout(() => this.flushSystemSoon(), 300);
  }

  /**
   * Вставка в голос, которая требует ответа (turnComplete=true), — только между ходами.
   * Раньше результат помощника уходил посреди ответа и обрывал голос на полуслове:
   * «Привет! Всё отлично, готов…» → сразу про треды (приёмка 03.11).
   */
  injectWhenQuiet(text: string) {
    if (this.ended) return;
    if (this.voiceTalking) {
      this.quietQueue.push(text);
      return;
    }
    this.deps.store.event(this.deps.callId, "system_injected", { waited: false, text: text.slice(0, 120) });
    this.voice?.sendClientContent(text, true);
  }

  private flushQuietQueue() {
    if (this.quietQueue.length === 0) return;
    const text = this.quietQueue.join("\n\n").slice(0, 6000);
    this.quietQueue = [];
    this.deps.store.event(this.deps.callId, "system_injected", { waited: true, text: text.slice(0, 120) });
    this.voice?.sendClientContent(text, true);
  }

  private flushSystemSoon() {
    if (this.systemBatch.length === 0) return;
    const batch = this.systemBatch;
    this.systemBatch = [];
    const text = `[СИСТЕМА] ${batch.join("\n")}`.slice(0, 4000);
    this.ledger.add("tool", text);
    this.deps.store.event(this.deps.callId, "system_batch", { text: text.slice(0, 300) });
    this.injectWhenQuiet(text);
  }

  private onConfirmationUpdate(p: PendingConfirmation, phase: "asking" | "listening") {
    const word = p.class === "L" ? "запускай" : p.class === "P" ? "разрешаю" : "да";
    this.frame({
      type: "confirmation",
      confirmationId: p.confirmationId,
      class: p.class,
      tool: p.tool,
      summary: p.say,
      word,
      expiresAt: new Date(p.expiresAt).toISOString(),
      phase,
    });
    if (phase === "asking") {
      // В режиме router вопрос зачитывает VOICE по [СИСТЕМА] с готовой фразой.
      if (this.mode === "extended") {
        this.injectWhenQuiet(`[СИСТЕМА] Скажи владельцу: ${p.say}`);
      }
      this.ledger.add("system", p.say);
    }
  }

  private actionSeq = 0;
  private newActionId(tool: string): string {
    this.actionSeq += 1;
    return `${tool}:${this.actionSeq}`;
  }

  /** Вердикт и время — реплика, которая подтвердила или вызвала подсказку, в ROUTER не идёт. */
  private lastVerdict: { verdict: string; at: number } | null = null;

  /**
   * Пока ждёт подтверждение, ответ владельца — только для ConfirmationGate (спека §2.1 п. 2).
   * Иначе ROUTER слышит «запускай» как новую команду и вызывает инструмент второй раз
   * (воспроизведено 02.11; прежнее условие isMicOpen() пропускало ответ в открытом окне).
   * Отказ снимает pending раньше, чем реплика дойдёт сюда, — она уходит в ROUTER как обычная.
   */
  private routerMayHearOwner(): boolean {
    if (this.gate.pendingConfirmation()) return false;
    const v = this.lastVerdict;
    if (v && (v.verdict === "approved" || v.verdict === "hint") && Date.now() - v.at < 2500) return false;
    return true;
  }

  private async onVerdict(p: PendingConfirmation, verdict: "approved" | "hint" | "cancelled" | "expired" | "not_confirmed") {
    this.lastVerdict = { verdict, at: Date.now() };
    this.frame({ type: "confirmation_result", confirmationId: p.confirmationId, verdict });
    this.deps.store.event(this.deps.callId, "verdict", { tool: p.tool, verdict });
    if (verdict !== "approved") {
      const message =
        verdict === "cancelled"
          ? "владелец отменил действие"
          : verdict === "expired"
            ? "отменено: истёк срок подтверждения"
            : "владелец не подтвердил";
      this.resolvePendingToolResponse(p.argsHash, { ok: false, error: { code: "cancelled", message } });
      // Аудит PLUG-108: в одной сессии модель тоже должна узнать об отмене (раньше — только в Extended).
      this.injectWhenQuiet(`[СИСТЕМА] ${message}. Не повторяй этот вызов без новой просьбы владельца.`);
      return;
    }
    // Исполняет сервер немедленно (кнопка и voice в обоих режимах, спека §7.1 п. 7).
    const def = toolByName(p.tool, this.targetThreadId ?? undefined);
    if (!def) return;
    const actionId = this.newActionId(p.tool);
    this.frame({ type: "action", actionId, tool: p.tool, class: p.class, status: "running", summary: p.say });
    let result: ToolResult;
    try {
      result = await def.execute(this.storedArgsOf(p), this.toolContext());
    } catch (e) {
      result = { ok: false, error: { code: "internal", message: String(e) } };
    }
    this.gate.consume(p.confirmationId);
    this.frame({
      type: "action",
      actionId,
      tool: p.tool,
      class: p.class,
      status: result.ok ? "done" : "failed",
      // карточка показывает итог, а не вопрос: «Поставить задачу …? Скажи «да»…» после выполнения путало владельца
      summary: result.ok ? `Выполнено: ${p.tool}` : `Не выполнено: ${p.tool}`,
    });
    this.resolvePendingToolResponse(p.argsHash, result);
    // Модель узнаёт результат через вставку [СИСТЕМА] в обоих режимах:
    // в native toolResponse уже отдан как needsConfirmation, повторять его некому.
    const text = result.ok
      ? `выполнено: ${p.tool}. ${JSON.stringify(result.data).slice(0, 600)}`
      : `не выполнено: ${"error" in result ? result.error.message : "нужно подтверждение"}`;
    // Если владелец подтвердил раньше, чем голос успел задать вопрос (кнопка), голос мог позже
    // зачитать уже решённый вопрос и получить второе «да» (живая проверка 03.11).
    this.injectWhenQuiet(`[СИСТЕМА] ${text} Вопрос подтверждения уже решён владельцем — НЕ задавай его снова и не вызывай ${p.tool} повторно.`);
  }

  /** Аргументы сохранённого вызова записи — они же в argsHash, подмена исключена. */
  private storedArgs = new Map<string, Record<string, unknown>>();
  private storedArgsOf(p: PendingConfirmation): Record<string, unknown> {
    return this.storedArgs.get(p.argsHash) ?? {};
  }

  private resolvePendingToolResponse(hash: string, result: ToolResult) {
    const wait = this.pendingToolResponses.get(hash);
    if (!wait) return;
    this.pendingToolResponses.delete(hash);
    this.router?.sendToolResponse(wait.functionId, result, "SILENT", wait.def);
  }

  /** Первая законченная реплика владельца создаёт тред звонка (контракт §6 п. 2). */
  private spawnPromise: Promise<void> | null = null;
  private async maybeSpawnThreadOnFirstUtterance() {
    if (this.threadId || this.ended) return;
    const first = this.ledger.lastOwnerUtterances(1)[0];
    if (!first) return;
    this.spawnPromise = (async () => {
      const id = await this.deps.spawnCallThread(first);
      if (id) {
        this.threadId = id;
        this.deps.store.setThread(this.deps.callId, id);
        this.frame({ type: "thread", threadId: id });
      }
    })();
    await this.spawnPromise;
  }

  /** Прямой текстовый ввод владельца (из UI чата или тестового скрипта, контракт §12.5). */
  sendUserMessage(text: string) {
    if (this.ended || !text.trim()) return;
    this.frame({ type: "transcript", role: "owner", text: text.trim(), final: true });
    this.onOwnerUtteranceFinal(text.trim());
    this.voice?.sendClientContent(text.trim(), true);
  }

  /** Аудио владельца из браузера. */
  onBrowserAudio(pcm: Uint8Array) {
    this.trackMic(pcm);
    if (this.ended || this.muted) return;
    if (!this.gate.isMicOpen()) {
      // Шлюз закрыт: в Gemini идёт тишина, транскрипт отбрасывается (спека §7.1 п. 3.1).
      return;
    }
    // Полный дуплекс с приглушением: пока агент говорит, микрофон ×0.25 —
    // эхо из динамиков падает ниже порога VAD Gemini, а громкая речь владельца
    // пробивается (перебивание голосом работает). Слой 1 из 2 против эха.
    if (pcm.length > MIC_FRAME_BYTES * 8) return; // защита от некадренного потока
    let outgoing = pcm;
    if (this.state === "speaking") {
      const ducked = new Int16Array(pcm.length >> 1);
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
        const v = Math.round(view.getInt16(i, true) * 0.25);
        ducked[i >> 1] = Math.max(-32768, Math.min(32767, v));
      }
      outgoing = new Uint8Array(ducked.buffer);
    }
    this.voice?.sendAudio(outgoing);
    if (this.mode === "extended" && this.deps.routerInput === "audio" && this.routerMayHearOwner()) this.router?.sendAudio(pcm);
    if (this.state === "listening") this.setState("listening");
  }

  private trackMic(pcm: Uint8Array) {
    this.micBytes += pcm.length;
    // pcm идёт со смещением 5 байт от начала WS-кадра — Int16Array требует кратность 2,
    // поэтому пиковая амплитуда через DataView (иначе RangeError убивает весь поток).
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i + 1 < view.byteLength; i += 8) {
      const v = Math.abs(view.getInt16(i, true));
      if (v > this.micPeak) this.micPeak = v;
    }
    if (!this.micReporter) {
      this.micReporter = setInterval(() => {
        const peak = this.micPeak;
        this.micPeak = 0;
        const bytes = this.micBytes;
        this.micBytes = 0;
        if (bytes === 0) return;
        bb_log(this.deps, `микрофон: ${bytes} байт/5с, пик ${peak}`);
        // Тишина после того, как владелец уже говорил, — пауза, а не сломанный микрофон.
        if (peak < 40 && bytes > 10_000 && this.ledger.lastOwnerUtterances(1).length === 0) {
          this.frame({ type: "warning", code: "mic_silent", message: "микрофон почти молчит: проверь, не замучен ли он в системе и в браузере" });
        }
      }, 5000);
      this.micReporter.unref?.();
    }
  }

  /** Кадр playback_drained из браузера: открывает окно подтверждения. */
  onPlaybackDrained(turnSeq: number) {
    this.gate.onPlaybackDrained(turnSeq);
    this.lastDrainedSeq = Math.max(this.lastDrainedSeq ?? turnSeq, turnSeq);
    if (this.lastAudioTurnSeq === null || turnSeq >= this.lastAudioTurnSeq) {
      if (this.listenFallback) { clearTimeout(this.listenFallback); this.listenFallback = null; }
      if (this.state === "speaking" && !this.voiceTalking) this.setState("listening");
    }
  }

  /** Длина звука текущего хода и запасной переход в «listening», если браузер не прислал playback_drained. */
  private turnAudioBytes = 0;
  private turnFirstAudioAt = 0;
  private lastAudioTurnSeq: number | null = null;
  private listenFallback: NodeJS.Timeout | null = null;
  private lastDrainedSeq: number | null = null;
  private scheduleListenAfterPlayback() {
    const bytes = this.turnAudioBytes;
    this.turnAudioBytes = 0;
    if (this.listenFallback) { clearTimeout(this.listenFallback); this.listenFallback = null; }
    // Браузер мог доиграть звук раньше, чем пришёл turnComplete: второго playback_drained не будет.
    const drainedAlready = this.lastAudioTurnSeq !== null && this.lastDrainedSeq !== null && this.lastDrainedSeq >= this.lastAudioTurnSeq;
    if (bytes === 0 || drainedAlready) {
      if (this.state === "speaking") this.setState("listening");
      return;
    }
    const audioMs = (bytes / BYTES_PER_SECOND_24K) * 1000;
    const remaining = Math.max(0, audioMs - (Date.now() - this.turnFirstAudioAt));
    this.listenFallback = setTimeout(() => {
      this.listenFallback = null;
      if (this.state === "speaking" && !this.voiceTalking) this.setState("listening");
    }, remaining + 2500);
    this.listenFallback.unref?.();
  }

  /** 700 мс тишины во входном транскрипте — реплика владельца закончена. */
  private finalizeOwnerUtterance() {
    this.ownerUtteranceTimer = null;
    this.toolCallsThisTurn = 0;
    const u = this.ownerUtterance;
    this.ownerUtterance = null;
    if (!u || !u.text.trim()) return;
    const text = u.text.trim();
    // Слой 2 против эха: реплика, совпадающая с тем, что агент только что говорил,
    // — это его голос из динамиков, а не владелец. Отбрасываем и не провоцируем ответ.
    if (Date.now() - this.lastAgentLineAt < 3000 && isEcho(text, this.lastVoiceLine)) {
      this.deps.store.event(this.deps.callId, "echo_dropped", { text: text.slice(0, 200) });
      this.voice?.sendClientContent("[СИСТЕМА] Предыдущая реплика была эхом твоего ответа из динамиков, а не словами владельца. Игнорируй её и жди владельца.", false);
      return;
    }
    this.frame({ type: "transcript", role: "owner", text, final: true });
    this.onOwnerUtteranceFinal(text);
  }

  /** Реплика владельца завершена (VAD или транскрипт-таймер): ROUTER, вариант А. */
  onOwnerUtteranceFinal(text: string) {
    if (this.ended || !text.trim()) return;
    this.lastFailedTool = null;
    this.toolCallsThisTurn = 0;
    this.ledger.add("owner", text);
    this.deps.store.event(this.deps.callId, "owner_line", { text });
    if (this.mode === "extended" && this.router && this.deps.routerInput === "text" && this.routerMayHearOwner()) {
      this.router.sendRealtimeText(`[голос сказал: «${this.lastVoiceLine}»] Владелец: ${text}`);
    }
    void this.advanceThreadAfterFirst(text);
  }

  private async advanceThreadAfterFirst(text: string) {
    if (!this.threadId) await this.maybeSpawnThreadOnFirstUtterance();
    else await this.deps.advanceCallThread(text);
  }

  async switchMode(mode: "normal" | "extended", source: "browser" | "tool" = "browser") {
    if (mode === "extended" && !this.deps.allowExtended) return; // Extended отключён (ADR-0006, пересмотр 2)
    if (this.targetThreadId || mode === this.mode || this.ended) return;
    this.deps.store.event(this.deps.callId, "mode_switch", { to: mode, source, msSinceStart: Date.now() - this.startedAt });
    if (this.gate.pendingConfirmation()) {
      this.frame({ type: "error", code: "pending_confirmation", message: "дождись ответа на подтверждение", retryable: false });
      return;
    }
    this.frame({ type: "mode", mode, switching: true });
    this.mode = mode;
    this.modeHistory.push(mode);
    this.deps.store.setModeHistory(this.deps.callId, this.modeHistory);
    this.router?.close();
    this.router = null;
    this.voice?.close();
    // Handle возобновления привязан к модели и живой сессии: с другой моделью Google
    // отвечает 1008 «already connected», затем 1007 (приёмка 02.11). При смене режима —
    // новая сессия без handle, контекст переносит пересказ ниже.
    await this.openSessions(undefined);
    // Пересказ новой сессии: тот же механизм, что смена ключа (спека §2.1).
    // Новая сессия продолжает разговор, а не начинает его: без приветствия, иначе владелец
    // слышит «второго агента» другим голосом (приёмка 03.11).
    this.voice?.sendClientContent(
      `[СИСТЕМА] Режим звонка переключён. Ты продолжаешь тот же разговор. Не здоровайся, не представляйся, не повторяй сказанное — молчи, пока владелец не заговорит. Пересказ:\n${this.ledger.handoverSummary()}`,
      false,
    );
    this.frame({ type: "mode", mode, switching: false });
    this.setState("listening");
  }

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnect1008 = 0;
  private reconnectAttempts = 0;
  private routerReconnects = 0;
  /** goAway/обрыв: переподключение; handle опционален — после 1008 сессия не возобновляется. */
  private async reconnectVoice(timeLeftSec: number, handle?: string) {
    if (this.ended || this.reconnectTimer) return;
    // Backoff: 1, 2, 4, 8, 10 c; успешный ход сбрасывает счётчик.
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 5);
    const backoff = Math.min(500 * 2 ** this.reconnectAttempts, 10_000);
    const waitMs = Math.max(backoff, Math.min(timeLeftSec * 1000, 10_000) - 1500);
    this.setState("reconnecting", "переподключаюсь");
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.ended) return;
      const useHandle = handle === undefined ? this.voice?.sessionHandle ?? undefined : handle;
      const old = this.voice;
      this.voice = null;
      old?.close();
      try {
        // Переподключается только голос; помощник Extended жив и не дублируется.
        this.voice = this.makeVoiceSession(useHandle);
        this.voice?.sendClientContent(`[СИСТЕМА] Переподключение. Пересказ:\n${this.ledger.handoverSummary()}`, false);
      } catch {
        this.frame({ type: "error", code: "google_unreachable", message: "не удалось переподключиться", retryable: true });
      }
      this.setState("listening");
    }, waitMs);
  }

  private switchKeyOnQuota(reason: "quota" | "unavailable") {
    try {
      this.pool.switchOnQuota();
      // Новый ключ — новый handle: старая сессия не возобновляется, нужен пересказ.
      this.voice?.close();
      void this.openSessions(undefined).then(() => {
        if (this.ended) {
          this.closeSessions();
          return;
        }
        this.voice?.sendClientContent(`[СИСТЕМА] Смена ключа. Пересказ:\n${this.ledger.handoverSummary()}`, false);
        this.setState("listening");
      });
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        this.frame({ type: "error", code: "quota_all_keys", message: "квота обоих ключей исчерпана", retryable: false });
        void this.end("error");
      }
    }
  }

  /** Кнопки оверлея: явное действие владельца (спека §7.1 п. 7). */
  decideConfirmation(confirmationId: string, decision: "approve" | "cancel"): void {
    this.gate.decide(confirmationId, decision);
  }

  pendingConfirmation(): PendingConfirmation | null {
    return this.gate.pendingConfirmation();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.setState(muted ? "muted" : "listening");
  }

  async end(reason: "owner" | "limit" | "error"): Promise<void> {
    if (this.listenFallback) { clearTimeout(this.listenFallback); this.listenFallback = null; }
    if (this.ended) return;
    this.ended = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ownerUtteranceTimer) {
      clearTimeout(this.ownerUtteranceTimer);
      this.ownerUtteranceTimer = null;
    }
    const minutes = Math.round((Date.now() - this.startedAt) / 60000);
    const summary = `Звонок завершён (${reason === "owner" ? "по просьбе владельца" : reason === "limit" ? "лимит времени" : "ошибка"}), ${minutes} мин.`;
    if (this.threadId && this.threadId !== this.targetThreadId) {
      try {
        await this.deps.endCallThread(summary);
      } catch (e) {
        // Тихий пропуск недопустим: ошибка пишется в журнал звонка (контракт §13.1)
        this.deps.store.event(this.deps.callId, "thread_close_failed", {
          threadId: this.threadId,
          error: String((e as { message?: unknown })?.message ?? e),
        });
      }
    }
    const brain = this.brain;
    this.brain = null;
    if (brain) {
      try {
        await brain.archive();
      } catch (e) {
        this.deps.store.event(this.deps.callId, "brain_archive_failed", {
          error: String((e as { message?: unknown })?.message ?? e),
        });
      }
    }
    const v = this.voice;
    this.voice = null;
    v?.close();
    const r = this.router;
    this.router = null;
    r?.close();
    if (this.micReporter) {
      clearInterval(this.micReporter);
      this.micReporter = null;
    }
    this.deps.store.endCall(this.deps.callId, reason);
    this.frame({ type: "ended", callId: this.deps.callId, threadId: this.threadId, reason });
    this.setState("ended");
    this.emit("ended");
  }

  /** Проверка лимита минут: предупредить за 2 мин, закрыть на лимите. */
  checkTimeLimit() {
    if (this.ended) return;
    const elapsedMin = (Date.now() - this.startedAt) / 60000;
    const max = this.deps.maxCallMinutes;
    if (max - elapsedMin <= 2 && !this.tpmWarned) {
      this.tpmWarned = true;
      this.frame({ type: "warning", code: "call_ending", message: `до конца звонка меньше двух минут (лимит ${max})` });
      this.voice?.sendClientContent("[СИСТЕМА] Звонок скоро завершится по лимиту времени. Заверши мысль и попрощайся.", true);
    }
    if (elapsedMin >= max) void this.end("limit");
  }

  get callId(): string {
    return this.deps.callId;
  }

  get protocolVersion(): number {
    return PROTOCOL_VERSION;
  }
}

export const PLAYBACK_BYTES_PER_SECOND = BYTES_PER_SECOND_24K;

/**
 * Похожа ли реплика владельца на последнюю реплику агента (эхо из динамиков).
 * Пересечение значимых слов ≥ 60 % меньшей стороны. Чистая функция — покрыта тестом.
 */
export function isEcho(ownerText: string, agentText: string): boolean {
  const norm = (t: string) =>
    t.toLowerCase().replaceAll("ё", "е").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2);
  const owner = new Set(norm(ownerText));
  const agent = new Set(norm(agentText));
  if (owner.size === 0 || agent.size === 0) return false;
  let overlap = 0;
  for (const w of owner) if (agent.has(w)) overlap += 1;
  const smaller = Math.min(owner.size, agent.size);
  return overlap / smaller >= 0.6;
}

/** Диагностическая строка в хранилище звонка (видно в bb call transcript). */
function bb_log(deps: CallSessionDeps, message: string): void {
  try {
    deps.store.event(deps.callId, "mic", { message });
  } catch {
    // журнал не критичен
  }
}
