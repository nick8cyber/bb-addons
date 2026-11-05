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
import { DEFAULT_WORDS, classify } from "./classify.js";
import { ContextLedger } from "./context-ledger.js";
import { KeyPool, QuotaExhaustedError } from "./key-pool.js";
import { LiveClient } from "./live-client.js";
import { EMPTY_CONTEXT, projectVoiceInstruction, routerInstruction, threadRouterInstruction, threadVoiceInstruction, voiceInstructionExtended, voiceInstructionNormal, type PromptContext } from "./prompt.js";
import { TOOLS, capabilityList, formatConnectorSay, getProjectTools, nativeDeclarations, runToolCall, stripConfirmKeys, toolByName, type ToolDef, type TwoStepPreviewEntry } from "./tools.js";
import type { ToolClass, ToolResult } from "./contract.js";
import type { CallStore } from "./call-store.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ToolContext } from "./tools.js";
import { fetchThreadMessages, formatMessageTime, formatThreadMessagesBlock, type ThreadMessage } from "./thread-messages.js";
import { BrainCenter } from "./brain-center.js";
import { McpClient, extractConfirmToken, isValidConnectorToolName, makeConnectorToolName, mcpSchemaToGeminiParameters, toGeminiSchema } from "./mcp-client.js";
import { canonicalizeJson, ProjectRegistryManager, readProjectRepoConfig, resolveStrictClass, type ProjectConfig } from "./project-registry.js";
import { maskSecrets } from "./secret-filter.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makePreviewKey(tool: string, token: string): string {
  return `${tool}:${token}`;
}

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
  targetProjectId?: string;
  projectRegistry?: ProjectRegistryManager;
  projectSecrets?: Record<string, string>;
  rawProjectRegistry?: string;
  pendingRegistryChanges?: Array<{ projectId: string; title: string; hash: string; diff: string[] }>;
  storageDir?: string;
  /** Проект «Звонки» — сюда идёт мозговой центр для не-git треда (служебная папка плагина). */
  callsProjectId?: string;
  /** Аккаунты GitHub владельца: репозиторий с origin другого аккаунта — мозговой центр только читает. */
  ownGitAccounts?: string[];
  watchThread?: (threadId: string) => void;
  log?: { info(s: string): void; warn(s: string): void; error(s: string): void };
}

const COMPRESSION = { triggerTokens: 20000, targetTokens: 10000 };
/** Сколько вставки ждут ответа модели на реплику владельца, прежде чем уйти всё равно. */
const AWAIT_REPLY_MAX_MS = 12_000;

export class CallSession extends EventEmitter {
  state: CallState = "connecting";
  mode: "normal" | "extended";
  threadId: string | null = null;
  readonly targetThreadId: string | null = null;
  readonly targetProjectId: string | null = null;
  private projectTitle: string | null = null;
  private repoPromptMd: string | null = null;
  private connectorClients: McpClient[] = [];
  private projectConnectorTools: ToolDef[] = [];
  private failedConnectorIds: string[] = [];
  private twoStepPreviews = new Map<string, TwoStepPreviewEntry>();
  private knownTokens = new Set<string>();

  getTwoStepPreview(tool: string, token: string): TwoStepPreviewEntry | undefined {
    return this.twoStepPreviews.get(makePreviewKey(tool, token));
  }
  private pendingRegistry: { projectId: string; title: string; hash: string; diff: string[] } | null = null;
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
  private onInterruptReset?: () => void;
  private lastVoiceLine = "";
  /** Накопленные результаты инструментов одной реплики: уходит в VOICE одним пакетом. */
  private systemBatch: string[] = [];
  /** Голос сейчас генерирует ответ: вставка с turnComplete=true оборвала бы его на полуслове. */
  private voiceTalking = false;
  private quietQueue: string[] = [];
  /** Справки (сводка мозгового центра и т. п.) — уходят без хода модели. */
  private quietContext: string[] = [];
  /** Последний вердикт пришёл кнопкой (а не голосом) — его результат вставляется с обрывом хода. */
  private decidedByButtonId: string | null = null;
  /** До этого момента ждём ответа модели на реплику владельца (вставки не шлём). */
  private awaitingReplyUntil = 0;
  private quietFallback: NodeJS.Timeout | null = null;
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
  /** Мозговой центр ожидается (git-окружение треда) — для инструкции голоса. */
  private brainExpected = false;
  brainSummary: string | null = null;
  /** Последний упавший инструмент (§12.12 п. 3: запрет молчаливого повтора). */
  private lastFailedTool: string | null = null;
  /** Счётчик вызовов инструментов в текущем ходе владельца (§12.12 п. 4). */
  private toolCallsInCurrentTurn = 0;

  constructor(private deps: CallSessionDeps) {
    super();
    this.targetThreadId = deps.targetThreadId ?? null;
    this.targetProjectId = deps.targetProjectId ?? null;
    if (this.targetProjectId && deps.pendingRegistryChanges) {
      const match = deps.pendingRegistryChanges.find((p) => p.projectId === this.targetProjectId);
      if (match) {
        this.pendingRegistry = match;
        this.recordEvent( "registry_changed", {
          projectId: match.projectId,
          diff: match.diff,
        });
      }
    }
    // Extended отключён (ADR-0006, пересмотр 2): без allowExtended любой звонок — normal.
    this.mode = this.targetThreadId || this.targetProjectId || (deps.mode === "extended" && !deps.allowExtended) ? "normal" : deps.mode;
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
        ...DEFAULT_WORDS,
        toolExtras: { stop_thread: ["останавливай"] },
      },
      undefined,
      {
        onConfirmationUpdate: (p, phase, isHint) => this.onConfirmationUpdate(p, phase, isHint),
        onQuestionHeardAt: (p, at, offsetMs) => this.recordEvent("question_heard", { tool: p.tool, at, offsetMs: Math.round(offsetMs) }),
        onVerdict: (p, verdict, via, utteranceAt) => void this.onVerdict(p, verdict, via, utteranceAt),
        onEarlyApproval: (_p) => {
          this.interruptAndInject("[СИСТЕМА] Владелец сказал «да» до вопроса — это НЕ подтверждение, ничего не выполнено. Задай вопрос подтверждения коротко и дождись ответа");
        },
        onUnrecognized: (_p) => {
          this.interruptAndInject("[СИСТЕМА] Ответ владельца не распознан: ничего не выполнено и не отменено. Повтори вопрос подтверждения одной фразой и жди «да» или «нет»");
        },
        onHint: (p) => {
          const text = p.class === "L"
            ? "[СИСТЕМА] «Да» для этого действия не подходит, ничего не выполнено. Скажи владельцу одной фразой: «Для запуска скажи «запускай»» и жди ответа"
            : "[СИСТЕМА] «Да» для этого действия не подходит, ничего не выполнено. Скажи владельцу одной фразой: «Чтобы разрешить, скажи «разрешаю»» и жди ответа";
          this.interruptAndInject(text);
          this.ledger.add("system", text);
        },
        onWindowInvalidated: () => {
          if (this.ownerUtteranceTimer) {
            clearTimeout(this.ownerUtteranceTimer);
            this.ownerUtteranceTimer = null;
          }
          this.ownerUtterance = null;
        },
      },
    );
  }

  private sanitizeTokens(str: string): string {
    let result = str;
    for (const tok of this.knownTokens) {
      if (tok && result.includes(tok)) {
        result = result.replaceAll(tok, "***");
      }
    }
    return result;
  }

  private sanitizeTokensInValue<T>(v: T): T {
    if (typeof v === "string") {
      return this.sanitizeTokens(v) as T;
    }
    if (Array.isArray(v)) {
      return v.map((item) => this.sanitizeTokensInValue(item)) as T;
    }
    if (v && typeof v === "object") {
      const res: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
        const safeKey = this.sanitizeTokens(key);
        res[safeKey] = this.sanitizeTokensInValue(val);
      }
      return res as T;
    }
    return v;
  }

  private recordEvent(kind: string, payload: Record<string, unknown>) {
    const sanitized = this.sanitizeTokensInValue(payload) as Record<string, unknown>;
    this.deps.store.event(this.deps.callId, kind, sanitized);
  }

  private frame(f: ServerFrame) {
    const sanitized = this.sanitizeTokensInValue(f) as ServerFrame;
    this.deps.toBrowser(sanitized);
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
      targetProjectId: this.targetProjectId ?? undefined,
    });
    if (this.threadId) this.frame({ type: "thread", threadId: this.threadId });
    this.setState(this.muted ? "muted" : "listening");
    const p = this.gate.pendingConfirmation();
    if (p && p.verdict === null) {
      const word = p.class === "L" ? "запускай" : p.class === "P" ? "разрешаю" : "да";
      const phase = this.gate.windowOpen() ? "listening" : "asking";
      this.frame({
        type: "confirmation",
        confirmationId: p.confirmationId,
        class: p.class,
        tool: p.tool,
        summary: p.card ?? p.say,
        word,
        expiresAt: new Date(p.expiresAt).toISOString(),
        phase,
      });
    }
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
      this.recordEvent( "call_started", { targetThreadId: this.targetThreadId });
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
        const envPath = typeof envObj.path === "string" ? envObj.path : "";
        // BB запоминает «не git» на момент создания окружения: после `git init` в папке проекта
        // флаг остаётся false. Проверяем саму папку (тот же хост) — тогда мозговой центр получит worktree.
        if (!envObj.isGitRepo && envPath) {
          const { existsSync } = await import("node:fs");
          const { join: pjoin } = await import("node:path");
          if (existsSync(pjoin(envPath, ".git"))) {
            envObj = { ...envObj, isGitRepo: true };
            if (!envObj.branchName) {
              try {
                const { execFileSync } = await import("node:child_process");
                const br = execFileSync("git", ["-C", envPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 3000 }).trim();
                if (br && br !== "HEAD") envObj = { ...envObj, branchName: br };
              } catch {
                /* ветку не узнали — worktree от ветки по умолчанию */
              }
            }
          }
        }
        // Владелец 04.11: в чужие репозитории (origin не его аккаунта) не пушить и не менять без его слова —
        // мозговой центр там только читает (brain_task → changes_unavailable).
        if (envPath && envObj.isGitRepo) {
          try {
            const { execFileSync } = await import("node:child_process");
            const url = execFileSync("git", ["-C", envPath, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 3000 }).trim();
            const owner = /github\.com[:/]([^/]+)\//i.exec(url)?.[1]?.toLowerCase();
            const own = (this.deps.ownGitAccounts ?? []).map((x) => x.toLowerCase());
            if (owner && own.length > 0 && !own.includes(owner)) envObj = { ...envObj, foreignRemote: true };
          } catch {
            /* нет origin — репозиторий свой локальный */
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

      this.recordEvent( "thread_context", {
        messages: formatted.messagesCount,
        skipped: formatted.skippedCount,
        chars: formatted.chars,
      });

      this.brainExpected = true; // и в не-git проекте — в отдельной пустой папке (03.11)
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
        fallbackProjectId: this.deps.callsProjectId,
        allowModify: !envObj.foreignRemote,
        allMessages: this.threadMessages,
        storageDir: this.deps.storageDir ?? join(tmpdir(), "bb-live-call-brain"),
        log: this.deps.log,
      });

      this.brain.onSummaryReady = (summaryText, ms) => {
        this.brainSummary = summaryText;
        // Справка, а не ход (§12.11 п. 3, пересмотр 04.11): голос сводку сам не зачитывает,
        // а использует для ответов. Между ходами — чтобы не оборвать пересказ на полуслове.
        this.injectContextWhenQuiet(
          `[СИСТЕМА] Справка: сводка мозгового центра по всему треду (${ms} мс). Сам её не пересказывай — используй, когда владелец спросит о треде шире последних сообщений.\n${summaryText}`,
        );
      };

      this.brain.onSummaryTimeout = () => {
        this.injectContextWhenQuiet(
          `[СИСТЕМА] Справка: сводка мозгового центра не готова. Если владелец спросит о треде шире последних сообщений — скажи, что полной сводки нет, и отвечай по сообщениям треда.`,
        );
      };

      void this.brain.start().then((id) => {
        if (id) return;
        // Мозговой центр не запустился (не-git проект или worktree не создался, §12.11 п.1):
        // инструменты получают brain=null, голос не ждёт сводку и работает по сообщениям треда.
        this.brain = null;
        if (this.greeted) {
          this.injectContextWhenQuiet(
            "[СИСТЕМА] Справка: мозговой центр в этом звонке недоступен (brain_ask и brain_task не работают). Сам об этом не объявляй; скажи, только если владелец попросит мозговой центр.",
          );
        }
      });
      if (targetProjectId) {
        if (this.deps.pendingRegistryChanges) {
          const match = this.deps.pendingRegistryChanges.find((p) => p.projectId === targetProjectId);
          if (match) {
            this.pendingRegistry = match;
            this.recordEvent( "registry_changed", {
              projectId: match.projectId,
              diff: match.diff,
            });
          }
        }
        await this.initProjectConnectors(targetProjectId);
      }
    } else if (this.targetProjectId) {
      this.deps.store.startCall(this.deps.callId);
      this.recordEvent( "call_started", { projectId: this.targetProjectId });
      this.nowUtc = new Date().toISOString();
      await this.initProjectConnectors(this.targetProjectId);
    } else {
      this.deps.store.startCall(this.deps.callId);
    }

    if (this.bailIfEnded()) return;
    this.promptContext = await this.buildPromptContext();
    if (this.bailIfEnded()) return;
    this.deps.store.setModeHistory(this.deps.callId, this.modeHistory);
    try {
      await this.openSessions();
    } catch (e) {
      this.frame({ type: "error", code: "no_keys", message: String(e), retryable: false });
      return this.end("error");
    }
    if (this.bailIfEnded()) return;
    this.frame({
      type: "ready",
      callId: this.deps.callId,
      mode: this.mode,
      voice: this.deps.voice,
      keys: { active: this.pool.active, of: this.pool.of },
      targetThreadId: this.targetThreadId ?? undefined,
      targetProjectId: this.targetProjectId ?? undefined,
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

  /**
   * Звонок завершили, пока он стартовал (браузер закрыли, «Завершить» до ready): всё, что
   * успело открыться после end(), закрывается здесь, голос не открывается (ревью PLUG-113, D).
   */
  private bailIfEnded(): boolean {
    if (!this.ended) return false;
    const v = this.voice;
    this.voice = null;
    v?.close();
    for (const c of this.connectorClients) {
      try {
        c.close();
      } catch {
        // ignore
      }
    }
    this.connectorClients = [];
    return true;
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

  private async initProjectConnectors(projectId: string): Promise<void> {
    for (const c of this.connectorClients) {
      try {
        c.close();
      } catch {
        // ignore
      }
    }
    this.connectorClients = [];
    this.projectConnectorTools = [];
    this.failedConnectorIds = [];

    // Проверка текущего состояния проекта в реестре (§15.4 п. 7, §16.7 п. 2)
    if (this.deps.projectRegistry) {
      const list = this.deps.projectRegistry.listProjects(this.deps.rawProjectRegistry);
      const current = list.find((p) => p.projectId === projectId);
      if (this.targetThreadId) {
        // Звонок по треду запускает коннекторы только если проект есть в текущем реестре и утверждён
        if (!current || current.state !== "approved") {
          return;
        }
      } else if (!current || current.state === "invalid" || current.state === "rejected") {
        return;
      }
    }

    let projectTitle = projectId;
    let projectRoot = "";
    try {
      const p = (await this.deps.sdk.projects.get({ projectId })) as Record<string, unknown>;
      if (p?.name) projectTitle = String(p.name);
      const sources = (p?.sources ?? []) as Array<{ path?: string; isDefault?: boolean }>;
      projectRoot = sources.find((s) => s.isDefault)?.path ?? sources[0]?.path ?? "";
    } catch {
      // fallback
    }
    this.projectTitle = projectTitle;
    const repoEnv = readProjectRepoConfig(projectRoot);
    this.repoPromptMd = repoEnv.promptMd ?? null;

    const approved = this.deps.projectRegistry?.getApprovedConfig(projectId);
    if (!approved || this.ended) return;

    // Коннекторы проекта поднимаются параллельно (§14.2, review п. 9)
    const clients = approved.config.connectors.map((connCfg) => ({
      cfg: connCfg,
      client: new McpClient(connCfg, this.deps.projectSecrets, this.deps.log),
    }));

    for (const item of clients) {
      this.connectorClients.push(item.client);
    }

    const results = await Promise.allSettled(
      clients.map(async ({ client }) => {
        return await client.start(10_000);
      }),
    );

    if (this.ended) {
      for (const c of this.connectorClients) {
        try {
          c.close();
        } catch {
          // ignore
        }
      }
      return;
    }

    const connectorResults: Array<{ id: string; tools: string[]; ok: boolean }> = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const connCfg = approved.config.connectors[i];
      const client = clients[i].client;

      if (r.status === "rejected") {
        // Текст ошибки initialize от коннектора может нести секрет или URL с учёткой (§16.7 п. 4).
        const exact = (connCfg.secrets ?? []).map((n) => this.deps.projectSecrets?.[n] ?? "").filter((v) => v.length >= 4);
        const errStr = maskSecrets(String(r.reason?.message ?? r.reason), exact);
        const isMissingSecret = /connector_secret_missing/i.test(errStr);
        const reason = isMissingSecret ? "connector_secret_missing" : errStr.slice(0, 300);

        this.failedConnectorIds.push(connCfg.id);
        connectorResults.push({ id: connCfg.id, tools: [], ok: false });
        this.recordEvent( "connector_start_failed", { id: connCfg.id, reason });
        this.deps.log?.warn?.(`коннектор ${connCfg.id} недоступен: ${errStr}`);
        continue;
      }

      const tools = r.value;
      const toolNames: string[] = [];
      const connTools = connCfg.tools as Record<string, any> | undefined;

      for (const t of tools) {
        // Проверка имени (§14.3, review п. 7)
        const candidateName = makeConnectorToolName(connCfg.id, t.name);
        if (!isValidConnectorToolName(candidateName)) {
          this.recordEvent( "connector_tool_skipped", {
            id: connCfg.id,
            tool: t.name,
            reason: "invalid_name",
          });
          continue;
        }
        if (this.projectConnectorTools.some((x) => x.name === candidateName)) {
          this.recordEvent( "connector_tool_skipped", {
            id: connCfg.id,
            tool: t.name,
            reason: "name_collision",
          });
          continue;
        }

        // Проверка схемы параметров Gemini (§14.4, review п. 6)
        const isTwoStep = Boolean(connCfg.twoStep && connCfg.twoStep.includes(t.name));
        const geminiParams = toGeminiSchema(t.inputSchema, isTwoStep);
        if (!geminiParams) {
          this.recordEvent( "connector_tool_skipped", {
            id: connCfg.id,
            tool: t.name,
            reason: "schema_unsupported",
          });
          continue;
        }
        if (isTwoStep && Array.isArray((geminiParams as any)?.required)) {
          (geminiParams as any).required = (geminiParams as any).required.filter(
            (k: string) => k !== "confirm" && k !== "confirm_token",
          );
        }

        // Класс ручки (Object.hasOwn, review п. 7)
        const regCls = (connTools && Object.hasOwn(connTools, t.name) ? connTools[t.name] : connCfg.defaultClass) as any;
        const repoCls = repoEnv.tools && Object.hasOwn(repoEnv.tools, t.name) ? repoEnv.tools[t.name] : undefined;
        const strictCls = resolveStrictClass(regCls, repoCls);
        if (strictCls === "deny") continue;

        toolNames.push(t.name);
        const toolDef: ToolDef = {
          name: candidateName,
          cls: strictCls as ToolClass,
          twoStep: isTwoStep,
          isConnector: true,
          word: strictCls === "C" ? "да" : strictCls === "P" ? "разрешаю" : strictCls === "L" ? "запускай" : "",
          description: (t.description || `Ручка ${t.name} коннектора ${connCfg.id}`).slice(0, 1000),
          parameters: geminiParams,
          // §14.5, §16.7 п. 3: вслух — имя ручки и аргументы коротко, без «Подтверждаете?»
          // (эхо «подтверждаете» распознавалось как «подтверждаю» — ревью PLUG-113, C);
          // карточка — все аргументы полностью.
          confirmSay: (args: Record<string, unknown>) => formatConnectorSay(t.name, connCfg.id, args).say,
          confirmCard: (args: Record<string, unknown>) =>
            `${t.name} (${connCfg.id})\n${Object.entries(args ?? {})
              .map(([k, v]) => `${k} = ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
              .join("\n")}`,
          execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
            const startMs = Date.now();
            const res = await client.callTool(t.name, args, 30_000);
            const ms = Date.now() - startMs;
            this.recordEvent( "connector_call", {
              connector: connCfg.id,
              tool: t.name,
              cls: strictCls,
              ms,
              ok: res.ok,
            });
            if (!res.ok) {
              return {
                ok: false,
                error: res.error ?? { code: "connector_error", message: "ошибка вызова коннектора" },
              };
            }
            if (isTwoStep) {
              const token = extractConfirmToken(res.raw);
              const previewText = res.maskedFullText ?? (res.data?.result ?? "");
              return {
                ok: true,
                data: res.data ?? { result: "" },
                confirm_token: token,
                previewText,
              };
            }
            return {
              ok: true,
              data: res.data ?? { result: "" },
            };
          },
        };
        this.projectConnectorTools.push(toolDef);
      }
      connectorResults.push({ id: connCfg.id, tools: toolNames, ok: true });
    }
    if (connectorResults.length > 0) {
      this.recordEvent( "project_context", { connectors: connectorResults });
    }
  }

  private resolveTool(name: string): ToolDef | undefined {
    const extra = this.projectConnectorTools.find((t) => t.name === name);
    if (extra) return extra;
    return toolByName(name, this.targetThreadId ?? undefined, this.projectConnectorTools, Boolean(this.targetProjectId));
  }

  private makeVoiceSession(handle?: string): LiveClient {
    this.voiceTalking = false;
    const systemInstruction = this.targetProjectId
      ? projectVoiceInstruction({
          projectTitle: this.projectTitle ?? this.targetProjectId,
          projectId: this.targetProjectId,
          promptMd: this.repoPromptMd ?? undefined,
          nowUtc: this.nowUtc,
          memory: this.promptContext.memory,
          failedConnectors: this.failedConnectorIds.length > 0 ? this.failedConnectorIds : undefined,
          availableTools: this.projectConnectorTools.map((t) => t.name),
        })
      : this.targetThreadId
        ? threadVoiceInstruction({
            thread: this.threadMeta ?? { id: this.targetThreadId, title: "Тред" },
            nowUtc: this.nowUtc,
            threadState: this.threadState,
            messagesBlock: this.threadMessagesBlock,
            memory: this.promptContext.memory,
            brainSummary: this.brainSummary ?? undefined,
            brainAvailable: this.brain !== null && this.brainExpected,
            projectToolsLine:
              this.projectConnectorTools.length > 0
                ? `доступны ручки проекта «${this.threadMeta?.project ?? "проекта"}»: ${this.projectConnectorTools.map((t) => t.name).join(", ")}.`
                : undefined,
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
      tools:
        this.mode === "normal"
          ? (nativeDeclarations(
              this.targetThreadId ?? undefined,
              this.projectConnectorTools,
              Boolean(this.targetProjectId),
            ) as unknown[])
          : undefined,
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
    const wrappedLedger: ContextLedger = {
      add: (role, text, at) => this.ledger.add(role, this.sanitizeTokens(text), at),
      lastOwnerUtterances: (n) => this.ledger.lastOwnerUtterances(n).map((s) => this.sanitizeTokens(s)),
      handoverSummary: () => this.sanitizeTokens(this.ledger.handoverSummary()),
    } as ContextLedger;

    return {
      sdk: this.deps.sdk,
      gate: this.gate,
      ledger: wrappedLedger,
      targetThreadId: this.targetThreadId ?? undefined,
      targetProjectId: this.targetProjectId ?? undefined,
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
        add: (text: string) => this.deps.store.addMemory(this.sanitizeTokens(text)),
        list: () => this.deps.store.listMemory(),
      },
      reportAction: (tool: string, cls: ToolClass, status: "running" | "done" | "failed" | "cancelled", summary: string, threadId?: string, actionId?: string) => {
        const safeSummary = this.sanitizeTokens(summary);
        this.frame({
          type: "action",
          actionId: actionId ?? this.newActionId(tool),
          tool,
          class: cls,
          status,
          summary: safeSummary,
          threadId,
        });
        this.recordEvent( "action", { tool, cls, status, summary: safeSummary, threadId });
        if (tool === "end_call" && status === "done") void this.end("owner");
        if (tool === "switch_mode" && status === "running") void this.switchMode(summary === "extended" ? "extended" : "normal", "tool");
      },
      callsProjectId: () => null,
      watchThread: this.deps.watchThread,
      rememberArgs: (hash: string, args: Record<string, unknown>) => {
        if (!this.storedArgs.has(hash)) {
          this.storedArgs.set(hash, structuredClone(args));
        }
      },
      savePreview: (tool: string, token: string, args: Record<string, unknown>, previewText: string) => {
        const cleanArgs = stripConfirmKeys(args);
        const key = makePreviewKey(tool, token);
        this.knownTokens.add(token);
        this.twoStepPreviews.set(key, {
          tool,
          token,
          args: cleanArgs,
          argsCanonical: JSON.stringify(canonicalizeJson(cleanArgs)),
          previewText,
          createdAt: Date.now(),
        });
      },
      getPreview: (tool: string, token: string) => {
        return this.twoStepPreviews.get(makePreviewKey(tool, token));
      },
      deletePreview: (tool: string, token: string) => {
        this.twoStepPreviews.delete(makePreviewKey(tool, token));
      },
    } as unknown as ToolContext;
  }

  private wireVoice(client: LiveClient) {
    const ctx = this.toolContext();
    client.on("setupComplete", () => {
      if (this.greeted) return; // после переподключений приветствие не повторяем
      this.greeted = true;
      if (this.targetProjectId) {
        const parts: string[] = [];
        if (this.failedConnectorIds.length > 0) {
          parts.push(this.failedConnectorIds.map((c) => `коннектор ${c} недоступен`).join(", "));
        }
        if (this.pendingRegistry) {
          parts.push("реестр проекта изменился, подтверди изменения в настройках плагина");
        }
        if (parts.length > 0) {
          client.sendClientContent(
            `[СИСТЕМА] Звонок по проекту ${this.projectTitle ?? this.targetProjectId} начат. В начале звонка скажи владельцу одной фразой: «${parts.join(". ")}». Больше ничего не добавляй и жди слов владельца.`,
            true,
          );
        } else {
          client.sendClientContent(
            `Система: звонок по проекту ${this.projectTitle ?? this.targetProjectId} начат. Жди первого слова владельца и отвечай только ему.`,
            false,
          );
        }
      } else if (this.targetThreadId) {
        let registryMsg = "";
        if (this.pendingRegistry) {
          registryMsg = " Скажи владельцу: «реестр проекта изменился, подтверди изменения в настройках плагина».";
        }
        // §12.11 п. 3 (слово владельца 04.11): без вопроса владельца — сразу пересказ ответа агента
        // на последний запрос владельца; мозговой центр не ждём.
        client.sendClientContent(
          `Система: звонок по треду начат. Владелец пока ничего не спросил — по правилу ПЕРВАЯ РЕПЛИКА сразу скажи «Привет» и перескажи ответ агента на последний запрос владельца.${registryMsg}`,
          true,
        );
      } else {
        // Обычный звонок координатору: фраза о реестре не звучит (§16.7 п. 6, review п. 10)
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
      agentBuf = "";
      streamPending = "";
      this.setState("listening");
    });
    let agentBuf = "";
    let streamPending = "";
    this.onInterruptReset = () => {
      agentBuf = "";
      streamPending = "";
    };
    const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

    const flushStream = (final: boolean) => {
      if (this.knownTokens.size === 0) {
        if (streamPending) {
          const out = streamPending;
          streamPending = "";
          this.frame({ type: "transcript", role: "agent", text: out, final: false });
        }
        return;
      }
      streamPending = this.sanitizeTokens(streamPending);
      if (final) {
        if (streamPending) {
          const out = streamPending;
          streamPending = "";
          this.frame({ type: "transcript", role: "agent", text: out, final: false });
        }
        return;
      }
      let maxTokenLen = 0;
      for (const tok of this.knownTokens) {
        if (tok.length > maxTokenLen) maxTokenLen = tok.length;
      }
      const tailLen = Math.max(0, maxTokenLen - 1);
      if (streamPending.length > tailLen) {
        let safeLen = streamPending.length - tailLen;
        const code = streamPending.charCodeAt(safeLen - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          safeLen -= 1;
        }
        if (safeLen > 0) {
          const out = streamPending.slice(0, safeLen);
          streamPending = streamPending.slice(safeLen);
          this.frame({ type: "transcript", role: "agent", text: out, final: false });
        }
      }
    };

    client.on("outputTranscript", (rawText: string | Uint8Array) => {
      const text = typeof rawText === "string" ? rawText : utf8Decoder.decode(rawText, { stream: true });
      if (!text) return;
      // Транскрипт приходит и кусками, и кумулятивно в аудио-сообщениях:
      // кумулятивный кусок, начинающийся с накопленного, ЗАМЕНЯЕТ его, а не дублирует.
      let delta = "";
      if (text.startsWith(agentBuf) && agentBuf.length > 0) {
        delta = text.slice(agentBuf.length);
        agentBuf = text;
      } else if (agentBuf.startsWith(text)) {
        return; // кусок уже внутри накопленного
      } else {
        delta = text;
        agentBuf += text;
      }
      // Шлюзу — склеенный текст хода: кусок может резать слово («ок»+«ей»), ревью PLUG-113.
      this.gate.onModelTranscript(agentBuf);
      if (delta) {
        streamPending += delta;
        flushStream(false);
      }
    });
    client.on("turnComplete", () => {
      this.voiceTalking = false;
      this.awaitingReplyUntil = 0;
      this.gate.onModelTurnComplete();
      // Аудит PLUG-108: состояние оставалось «speaking» до конца звонка — речь владельца уходила ×0.25.
      // Но снимать приглушение по turnComplete рано: браузер ещё доигрывает звук, эхо пошло бы в Gemini.
      // Поэтому: нет звука в ходе (текст) — сразу; есть — по playback_drained, запасной таймер по длине звука.
      this.scheduleListenAfterPlayback();
      this.flushQuietQueue();
      flushStream(true);
      void (async () => {
        // Сначала тред: иначе первая же реплика агента уйдёт в say до его создания и потеряется.
        await this.maybeSpawnThreadOnFirstUtterance();
        const line = agentBuf.trim();
        agentBuf = "";
        streamPending = "";
        this.reconnectAttempts = 0;
        if (!line) return;
        this.frame({ type: "transcript", role: "agent", text: line, final: true });
        this.lastVoiceLine = line.slice(0, 300);
        const safeLine = this.sanitizeTokens(line);
        this.ledger.add("agent", safeLine);
        this.recordEvent( "agent_line", { text: safeLine });
        this.lastAgentLineAt = Date.now();
        await this.deps.sayCallThread(safeLine);

        const p = this.gate.pendingConfirmation();
        if (p && p.verdict === null && this.gate.checkFalseClaim(line)) {
          this.recordEvent("false_claim", { tool: p.tool, text: safeLine.slice(0, 120) });
          this.interruptAndInject("[СИСТЕМА] Действие ещё не подтверждено и не выполнено. Задай вопрос подтверждения и дождись вердикта");
        }
      })();
    });
    client.on("inputTranscript", (text: string) => {
      if (!this.gate.isMicOpen()) return;
      this.frame({ type: "transcript", role: "owner", text, final: false });
      this.gate.onOwnerTranscriptChunk(text);
      this.markAwaitingReply();
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
      if (code === 1011 || String(code) === "429" || /exhausted|quota/i.test(text)) {
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
      // Сокет закрыли мы сами (конец звонка, смена ключа) — ошибка закрытия не новость для браузера.
      if (this.ended || this.voice !== client) return;
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
      const def = this.resolveTool(call.name);
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
      if (this.ended) return;
      // Голосовая сессия должна отреагировать на результат: WHEN_IDLE (SILENT запрещает ответ).
      client.sendToolResponse(call.id, result, "WHEN_IDLE", call.name);
      if (!result.ok && "error" in result) {
        this.lastFailedTool = call.name;
        // Для ручек коннектора аргументы в журнал не пишутся (§15.5, §16.7 п. 4, review п. 4)
        const isConnectorTool = this.projectConnectorTools.some((t) => t.name === def.name);
        this.recordEvent( "tool_error", {
          tool: def.name,
          ...(isConnectorTool ? {} : { args: call.args }),
          code: result.error.code,
          message: maskSecrets(result.error.message.slice(0, 300), Object.values(this.deps.projectSecrets ?? {}).filter((v) => v.length >= 4)),
        });
      } else if (result.ok) {
        this.lastFailedTool = null;
      }
      if (!result.ok && "needsConfirmation" in result) this.recordEvent("confirm", { tool: def.name });
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
      if (code === 1011 || String(code) === "429" || /exhausted|quota/i.test(reason ?? "")) {
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
      const def = this.resolveTool(call.name);
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
      const { result } = await runToolCall(def, call.args, call.id, this.toolContext());
      if (this.ended) return;
      if (result.ok) {
        client.sendToolResponse(call.id, result, "SILENT", call.name);
        this.enqueueSystem(def.name, result);
      } else if ("needsConfirmation" in result) {
        // Запись: toolResponse откладывается до вердикта (спека §2.1 п. 4).
        // Хеш записи считается по аргументам после resolve — ключ ответа берём у шлюза,
        // иначе вердикт искал бы ответ по хешу сырых аргументов (ревью PLUG-113).
        const pendingHash = this.gate.pendingConfirmation()?.argsHash ?? hash;
        this.pendingToolResponses.set(pendingHash, { functionId: call.id, def: def.name, args: call.args });
      } else {
        client.sendToolResponse(call.id, result, "SILENT", call.name);
        this.enqueueSystem(def.name, result);
      }
    }
    this.flushSystemSoon();
    setTimeout(() => {
      this.routerBusyCount = Math.max(0, this.routerBusyCount - 1);
    }, 3000);
  }

  /** Результат R-инструментов: один пакет [СИСТЕМА] в VOICE. */
  private enqueueSystem(tool: string, result: ToolResult) {
    const rawData = result.ok ? this.sanitizeTokensInValue(result.data) : null;
    const text = result.ok
      ? JSON.stringify(rawData)
      : `ошибка: ${"error" in result ? this.sanitizeTokens(result.error.message) : "нужно подтверждение"}`;
    this.systemBatch.push(this.sanitizeTokens(`инструмент ${tool}: ${text}`));
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
    const safeText = this.sanitizeTokens(text);
    // Ждём и конца речи, и ответа на только что сказанное владельцем: вставка сразу после его
    // реплики перебивала ещё не начатый ответ, и голос молчал (регрессия 04.11: сводка пришла
    // в ту же секунду, что и вопрос «что было последним в треде?»).
    const awaiting = Date.now() < this.awaitingReplyUntil;
    if (this.voiceTalking || awaiting) {
      this.quietQueue.push(safeText);
      if (awaiting && !this.voiceTalking) this.scheduleQuietFallback();
      return;
    }
    this.recordEvent( "system_injected", { waited: false, text: safeText.slice(0, 120) });
    this.voice?.sendClientContent(safeText, true);
  }

  /** Ответа на реплику владельца так и не было — вставка уходит по запасному таймеру. */
  private scheduleQuietFallback() {
    if (this.quietFallback) clearTimeout(this.quietFallback);
    const wait = Math.max(0, this.awaitingReplyUntil - Date.now());
    this.quietFallback = setTimeout(() => {
      this.quietFallback = null;
      if (this.ended || this.voiceTalking) return;
      this.awaitingReplyUntil = 0;
      this.flushQuietQueue();
    }, wait);
  }

  /** Владелец сказал реплику: до ответа модели (turnComplete) вставки ждут, не дольше 12 с. */
  private markAwaitingReply() {
    this.awaitingReplyUntil = Date.now() + AWAIT_REPLY_MAX_MS;
  }

  /** Справка в голос без хода модели (turnComplete=false) — только между ходами. */
  injectContextWhenQuiet(text: string) {
    if (this.ended) return;
    const safeText = this.sanitizeTokens(text);
    if (this.voiceTalking || Date.now() < this.awaitingReplyUntil) {
      this.quietContext.push(safeText);
      return;
    }
    this.recordEvent("system_context", { waited: false, text: safeText.slice(0, 120) });
    this.voice?.sendClientContent(safeText, false);
  }

  private flushQuietContext() {
    if (this.quietContext.length === 0) return;
    const text = this.sanitizeTokens(this.quietContext.join("\n\n")).slice(0, 8000);
    this.quietContext = [];
    this.recordEvent("system_context", { waited: true, text: text.slice(0, 120) });
    this.voice?.sendClientContent(text, false);
  }

  private flushQuietQueue() {
    this.flushQuietContext();
    if (this.quietFallback) {
      clearTimeout(this.quietFallback);
      this.quietFallback = null;
    }
    if (this.quietQueue.length === 0) return;
    const text = this.sanitizeTokens(this.quietQueue.join("\n\n")).slice(0, 6000);
    this.quietQueue = [];
    this.recordEvent( "system_injected", { waited: true, text: text.slice(0, 120) });
    this.voice?.sendClientContent(text, true);
  }

  private flushSystemSoon() {
    if (this.ended) return;
    if (this.systemBatch.length === 0) return;
    const batch = this.systemBatch;
    this.systemBatch = [];
    const text = this.sanitizeTokens(`[СИСТЕМА] ${batch.join("\n")}`).slice(0, 4000);
    this.ledger.add("tool", text);
    this.recordEvent( "system_batch", { text: text.slice(0, 300) });
    this.injectWhenQuiet(text);
  }

  private onConfirmationUpdate(p: PendingConfirmation, phase: "asking" | "listening", isHint = false) {
    // Журнал для приёмки: открытие окна ответа отделяет перебивание от ответа после вопроса.
    this.recordEvent( "confirm_phase", { tool: p.tool, phase });
    const word = p.class === "L" ? "запускай" : p.class === "P" ? "разрешаю" : "да";
    this.frame({
      type: "confirmation",
      confirmationId: p.confirmationId,
      class: p.class,
      tool: p.tool,
      summary: p.card ?? p.say,
      word,
      expiresAt: new Date(p.expiresAt).toISOString(),
      phase,
    });
    if (phase === "asking" && !isHint) {
      if (this.mode === "extended") {
        this.injectWhenQuiet(`[СИСТЕМА] Скажи владельцу: ${p.say}`);
      }
      this.ledger.add("system", this.sanitizeTokens(p.say));
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

  private async onVerdict(
    p: PendingConfirmation,
    verdict: "approved" | "hint" | "cancelled" | "expired" | "not_confirmed",
    via: "barge" | "window" | "button" | "system" = "system",
    utteranceAt: number = Date.now(),
  ) {
    if (this.ended) return;
    this.lastVerdict = { verdict, at: Date.now() };
    this.frame({ type: "confirmation_result", confirmationId: p.confirmationId, verdict });
    this.recordEvent("verdict", { tool: p.tool, verdict, via, utteranceAt });

    const def = this.resolveTool(p.tool);
    const stored = this.storedArgsOf(p);
    const token = typeof stored.confirm_token === "string" ? stored.confirm_token : "";
    const previewKey = token ? makePreviewKey(p.tool, token) : "";
    const isTwoStep = Boolean(def?.twoStep);

    if (verdict !== "approved") {
      // после approved/cancelled/expired запись удаляется: превью одноразовое (§14.10 п. 5)
      if (isTwoStep) {
        if (previewKey) {
          this.twoStepPreviews.delete(previewKey);
        }
        for (const [k, v] of this.twoStepPreviews) {
          if (v.tool === p.tool && (token ? v.token === token : true)) {
            this.twoStepPreviews.delete(k);
          }
        }
      }
      this.storedArgs.delete(p.argsHash);
      const message =
        verdict === "cancelled"
          ? "владелец отменил действие"
          : verdict === "expired"
            ? "отменено: истёк срок подтверждения"
            : "владелец не подтвердил";
      this.resolvePendingToolResponse(p.argsHash, { ok: false, error: { code: "cancelled", message } });
      // Аудит PLUG-108: в одной сессии модель тоже должна узнать об отмене (раньше — только в Extended).
      this.injectVerdict(p, `[СИСТЕМА] ${message}. Не повторяй этот вызов без новой просьбы владельца.`);
      return;
    }
    // Исполняет сервер немедленно (кнопка и voice в обоих режимах, спека §7.1 п. 7).
    if (!def) {
      this.gate.consume(p.confirmationId);
      this.storedArgs.delete(p.argsHash);
      const actionId = this.newActionId(p.tool);
      this.frame({
        type: "action",
        actionId,
        tool: p.tool,
        class: p.class,
        status: "failed",
        summary: `Не выполнено: ${p.tool}`,
      });
      const errResult: ToolResult = {
        ok: false,
        error: { code: "not_found", message: `инструмент не найден: ${p.tool}` },
      };
      this.resolvePendingToolResponse(p.argsHash, errResult);
      this.injectVerdict(p, `[СИСТЕМА] НЕ ВЫПОЛНЕНО: инструмент не найден: ${p.tool}. Скажи владельцу прямо, что не получилось; не говори «отправлено» или «готово».`);
      return;
    }
    const actionId = this.newActionId(p.tool);
    if (argsHash(p.tool, stored) !== p.argsHash) {
      this.gate.consume(p.confirmationId);
      this.storedArgs.delete(p.argsHash);
      this.frame({
        type: "action",
        actionId,
        tool: p.tool,
        class: p.class,
        status: "failed",
        summary: `Не выполнено: ${p.tool}`,
      });
      const errResult: ToolResult = {
        ok: false,
        error: { code: "invalid_argument", message: "аргументы действия были изменены" },
      };
      this.resolvePendingToolResponse(p.argsHash, errResult);
      this.injectVerdict(p, `[СИСТЕМА] НЕ ВЫПОЛНЕНО: аргументы действия были изменены. Скажи владельцу прямо, что не получилось; не говори «отправлено» или «готово».`);
      return;
    }
    this.frame({ type: "action", actionId, tool: p.tool, class: p.class, status: "running", summary: p.say });
    let result: ToolResult;

    if (isTwoStep) {
      const entry = previewKey ? this.twoStepPreviews.get(previewKey) : undefined;
      const TWO_STEP_TTL_MS = 10 * 60 * 1000;
      if (!entry || Date.now() - entry.createdAt > TWO_STEP_TTL_MS) {
        if (previewKey) this.twoStepPreviews.delete(previewKey);
        this.gate.consume(p.confirmationId);
        this.frame({
          type: "action",
          actionId,
          tool: p.tool,
          class: p.class,
          status: "failed",
          summary: `Не выполнено: ${p.tool}`,
        });
        const errResult: ToolResult = { ok: false, error: { code: "invalid_argument", message: "срок действия превью истёк" } };
        this.resolvePendingToolResponse(p.argsHash, errResult);
        this.injectVerdict(p, `[СИСТЕМА] НЕ ВЫПОЛНЕНО: срок действия превью истёк. Скажи владельцу прямо, что не получилось и почему; не говори «отправлено» или «готово».`);
        return;
      }
      // после approved/cancelled/expired запись удаляется: превью одноразовое (§14.10 п. 5)
      if (previewKey) this.twoStepPreviews.delete(previewKey);
      for (const [k, v] of this.twoStepPreviews) {
        if (v.tool === p.tool && (token ? v.token === token : true)) {
          this.twoStepPreviews.delete(k);
        }
      }
    }

    try {
      const rawRes = await def.execute(stored, this.toolContext());
      result = rawRes.ok
        ? { ok: true, data: rawRes.data, ...(rawRes.truncated !== undefined ? { truncated: rawRes.truncated } : {}) }
        : rawRes;
    } catch (e) {
      result = { ok: false, error: { code: "internal", message: String(e) } };
    } finally {
      this.storedArgs.delete(p.argsHash);
    }
    if (this.ended) return;
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
      : `НЕ ВЫПОЛНЕНО: ${"error" in result ? result.error.message : "нужно подтверждение"}. Скажи владельцу прямо, что не получилось и почему; не говори «отправлено» или «готово».`;
    // Если владелец подтвердил раньше, чем голос успел задать вопрос (кнопка), голос мог позже
    // зачитать уже решённый вопрос и получить второе «да» (живая проверка 03.11).
    this.injectVerdict(p, `[СИСТЕМА] ${text} Вопрос подтверждения уже решён владельцем — НЕ задавай его снова и не вызывай ${p.tool} повторно.`);
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
    this.onOwnerUtteranceFinal(text.trim(), "text_frame");
    this.markAwaitingReply();
    this.voice?.sendClientContent(text.trim(), true);
  }

  /** Аудио владельца из браузера. */
  onBrowserAudio(pcm: Uint8Array) {
    if (pcm.length % 2 !== 0 || pcm.length > MIC_FRAME_BYTES * 8) return;
    this.trackMic(pcm);
    if (this.ended || this.muted) return;
    if (!this.gate.isMicOpen()) {
      // Шлюз закрыт: в Gemini идёт тишина, транскрипт отбрасывается (спека §7.1 п. 3.1).
      return;
    }
    // Полный дуплекс с приглушением: пока агент говорит, микрофон ×0.25 —
    // эхо из динамиков падает ниже порога VAD Gemini, а громкая речь владельца
    // пробивается (перебивание голосом работает). Слой 1 из 2 против эха.
    if (!this.voice) return;
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
    const sent = typeof this.voice.sendAudio === "function" ? this.voice.sendAudio(outgoing) : false;
    if (sent === true) {
      this.gate.recordOwnerSpeech(pcm);
    }
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
      this.recordEvent( "echo_dropped", { text: text.slice(0, 200) });
      this.voice?.sendClientContent("[СИСТЕМА] Предыдущая реплика была эхом твоего ответа из динамиков, а не словами владельца. Игнорируй её и жди владельца.", false);
      return;
    }
    this.frame({ type: "transcript", role: "owner", text, final: true });
    this.onOwnerUtteranceFinal(text, "speech");
  }

  /** Реплика владельца завершена (VAD или транскрипт-таймер): ROUTER, вариант А. */
  onOwnerUtteranceFinal(text: string, source: "speech" | "text_frame" = "speech") {
    if (this.ended || !text.trim()) return;
    this.lastFailedTool = null;
    this.toolCallsThisTurn = 0;
    const safeText = this.sanitizeTokens(text);
    this.ledger.add("owner", safeText);
    this.recordEvent( "owner_line", { text: safeText });

    // §15.2 п. 4: Реплики звонка (речь, кадр text, кадр confirm) изменение реестра не подтверждают — только кнопка в настройках.

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
    this.recordEvent( "mode_switch", { to: mode, source, msSinceStart: Date.now() - this.startedAt });
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
      `[СИСТЕМА] Режим звонка переключён. Ты продолжаешь тот же разговор. Не здоровайся, не представляйся, не повторяй сказанное — молчи, пока владелец не заговорит. Пересказ:\n${this.sanitizeTokens(this.ledger.handoverSummary())}`,
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
        this.voice?.sendClientContent(`[СИСТЕМА] Переподключение. Пересказ:\n${this.sanitizeTokens(this.ledger.handoverSummary())}`, false);
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
        this.voice?.sendClientContent(`[СИСТЕМА] Смена ключа. Пересказ:\n${this.sanitizeTokens(this.ledger.handoverSummary())}`, false);
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
    if (this.ended) return;
    // Кнопка нажата, пока голос ещё говорит (часто — сам вопрос): ход модели обрываем, иначе
    // голос дочитывал уже решённый вопрос и «да» владельца уходило модели как новая реплика
    // (живая проверка 04.11). Результат действия вставится сразу, а не после конца хода.
    const before = this.gate.pendingConfirmation();
    const fresh = before?.confirmationId === confirmationId && before.verdict === null;
    this.decidedByButtonId = fresh ? confirmationId : null;
    const verdict = this.gate.decide(confirmationId, decision);
    // Подтверждение: обрываем ход СРАЗУ, не дожидаясь исполнения — медленное действие
    // (мозговой центр, коннектор) иначе давало голосу дочитать решённый вопрос.
    // Результат действия придёт позже обычной вставкой между ходами.
    if (verdict === "approved" && this.decidedByButtonId === confirmationId) {
      this.decidedByButtonId = null;
      this.interruptAndInject("[СИСТЕМА] Владелец подтвердил действие кнопкой — оно уже выполняется. Вопрос подтверждения НЕ задавай; скажи одной короткой фразой, что выполняешь, и жди результата.");
    }
  }

  /** Вставка с обрывом текущего хода: голос замолкает, браузер сбрасывает буфер. */
  private interruptAndInject(text: string) {
    if (this.ended) return;
    this.onInterruptReset?.();
    const safeText = this.sanitizeTokens(text);
    const hasPlayingAudio =
      this.voiceTalking ||
      this.state === "speaking" ||
      this.listenFallback !== null ||
      (this.lastAudioTurnSeq !== null && (this.lastDrainedSeq === null || this.lastDrainedSeq < this.lastAudioTurnSeq));
    if (hasPlayingAudio) {
      this.voiceTalking = false;
      this.turnAudioBytes = 0;
      if (this.listenFallback) {
        clearTimeout(this.listenFallback);
        this.listenFallback = null;
      }
      this.frame({ type: "interrupted", turnSeq: this.lastAudioTurnSeq ?? 0 });
      this.setState("listening");
    }
    const queued = this.quietQueue;
    this.quietQueue = [];
    const all = this.sanitizeTokens([safeText, ...queued].join("\n\n")).slice(0, 6000);
    this.recordEvent( "system_injected", { waited: false, interrupted: true, text: all.slice(0, 120) });
    this.voice?.sendClientContent(all, true);
  }

  /** Результат подтверждения — модели: после кнопки обрывом хода, после голоса — между ходами. */
  private injectVerdict(p: PendingConfirmation, text: string) {
    const byButton = this.decidedByButtonId === p.confirmationId;
    if (byButton) this.decidedByButtonId = null;
    if (byButton) this.interruptAndInject(text);
    else this.injectWhenQuiet(text);
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
    try {
      const pending = this.gate.pendingConfirmation();
      if (pending && pending.verdict === null) {
        this.recordEvent("verdict", { tool: pending.tool, verdict: "cancelled", reason: "call_ended" });
      }
    } catch {
      // Ошибка журнала не должна прерывать очистку сессии и завершение звонка (PLUG-120 R4)
    }
    this.gate.end();
    this.storedArgs.clear();
    this.twoStepPreviews.clear();
    if (this.systemBatchTimer) {
      clearTimeout(this.systemBatchTimer);
      this.systemBatchTimer = null;
    }
    this.systemBatch = [];
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
    // Сначала то, что слышит и видит владелец: голос замолкает, браузер получает ended.
    // Раньше это шло после остановки мозгового центра и закрытия треда звонка (секунды),
    // голос продолжал говорить, и «Завершить» приходилось нажимать несколько раз (приёмка 04.11).
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
    // Хост освобождается сразу и в любом случае: новый звонок не получает busy, а закрытие
    // сокета браузером после ended не запускает ожидание возврата. Ошибка записи в SQLite
    // не должна держать хост (ревью PLUG-113). Уборка ниже идёт фоном.
    try {
      this.deps.store.endCall(this.deps.callId, reason);
    } catch (e) {
      this.deps.log?.warn?.(`не записал конец звонка ${this.deps.callId}: ${String(e)}`);
    }
    this.frame({ type: "ended", callId: this.deps.callId, threadId: this.threadId, reason });
    this.setState("ended");
    this.emit("ending");
    if (this.threadId && this.threadId !== this.targetThreadId) {
      try {
        await this.deps.endCallThread(summary);
      } catch (e) {
        // Тихий пропуск недопустим: ошибка пишется в журнал звонка (контракт §13.1)
        this.recordEvent( "thread_close_failed", {
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
        this.recordEvent( "brain_archive_failed", {
          error: String((e as { message?: unknown })?.message ?? e),
        });
      }
    }
    for (const c of this.connectorClients) {
      try {
        c.close();
      } catch {
        // ignore
      }
    }
    this.connectorClients = [];
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
