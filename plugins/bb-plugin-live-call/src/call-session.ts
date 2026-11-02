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
import { routerInstruction, voiceInstructionExtended, voiceInstructionNormal } from "./prompt.js";
import { TOOLS, nativeDeclarations, runToolCall, toolByName } from "./tools.js";
import type { ToolClass, ToolResult } from "./contract.js";
import type { CallStore } from "./call-store.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ToolContext } from "./tools.js";

export type CallState =
  | "connecting" | "listening" | "thinking" | "speaking" | "working" | "reconnecting" | "muted" | "ended";

export interface CallSessionDeps {
  callId: string;
  keys: string[];
  voice: string;
  languageCode: string;
  thinkingLevel: "LOW" | "MEDIUM" | "HIGH";
  mode: "normal" | "extended";
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
}

const COMPRESSION = { triggerTokens: 20000, targetTokens: 10000 };

export class CallSession extends EventEmitter {
  state: CallState = "connecting";
  mode: "normal" | "extended";
  threadId: string | null = null;
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

  constructor(private deps: CallSessionDeps) {
    super();
    this.mode = deps.mode;
    this.modeHistory = [deps.mode];
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

  async start() {
    this.deps.store.startCall(this.deps.callId);
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
    });
    this.setState("listening");
    this.gateTicker();
  }

  private gateTicker() {
    if (this.ended) return;
    this.gate.tick();
    setTimeout(() => this.gateTicker(), 1000);
  }

  private async openSessions(handle?: string) {
    if (this.mode === "normal") {
      this.voice = this.makeVoiceSession(handle);
    } else {
      if (this.pool.count < 2) {
        // Фоллбэк: extended требует двух ключей (контракт §1).
        this.frame({ type: "warning", code: "extended_unavailable", message: "Extended требует два ключа, работаю в обычном режиме" });
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

  private makeVoiceSession(handle?: string): LiveClient {
    const client = new LiveClient({
      key: this.pool.activeKey,
      model: this.mode === "normal" ? "gemini-3.8-live" : "gemini-3.8-live-extended-thinking",
      voice: this.deps.voice,
      languageCode: this.deps.languageCode,
      systemInstruction: this.mode === "normal" ? voiceInstructionNormal() : voiceInstructionExtended(),
      thinkingLevel: this.mode === "normal" ? undefined : this.deps.thinkingLevel,
      tools: this.mode === "normal" ? nativeDeclarations() : undefined,
      sessionHandle: handle,
      contextWindowCompression: COMPRESSION,
      wsFactory: this.deps.wsFactory,
    });
    this.wireVoice(client);
    client.connect();
    return client;
  }

  private makeRouterSession(): LiveClient {
    const client = new LiveClient({
      key: this.pool.key(1),
      model: "gemini-3.8-live",
      voice: this.deps.voice,
      languageCode: this.deps.languageCode,
      systemInstruction: routerInstruction(),
      tools: nativeDeclarations(),
      contextWindowCompression: COMPRESSION,
      wsFactory: this.deps.wsFactory,
    });
    this.wireRouter(client);
    client.connect();
    return client;
  }

  private toolContext() {
    return {
      sdk: this.deps.sdk,
      gate: this.gate,
      ledger: this.ledger,
      newActionId: (tool: string) => this.newActionId(tool),
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
        if (tool === "switch_mode" && status === "running") void this.switchMode(summary === "extended" ? "extended" : "normal");
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
      // Модель молчит до первого слова владельца: любая просьба «поздоровайся»
      // приводила к тому, что она сама запускала обзор поверх владельца (02.11).
      // turnComplete: false — контекст получен, ответа не требуется.
      client.sendClientContent("Система: звонок начат. Жди первого слова владельца и отвечай только ему.", false);
    });
    client.on("audio", (turnSeq: number, pcm: Uint8Array) => {
      this.gate.onModelAudio(turnSeq, pcm.length);
      if (pcm.length > 0) this.deps.sendBrowserAudio(turnSeq, pcm);
      if (this.state !== "speaking" && pcm.length > 0) this.setState("speaking");
    });
    client.on("interrupted", (turnSeq: number | null) => {
      this.frame({ type: "interrupted", turnSeq: turnSeq ?? 0 });
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
      if (this.ended) return;
      const text = reason ?? "";
      // Gemini отдаёт квоту по-разному: 429, RESOURCE_EXHAUSTED, 1011 "Resource has been exhausted".
      if (String(code) === "429" || /exhausted|quota/i.test(text)) {
        this.switchKeyOnQuota("quota");
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
      const def = toolByName(call.name);
      if (!def) {
        client.sendToolResponse(call.id, { error: `неизвестный инструмент ${call.name}` });
        continue;
      }
      if (this.toolCallsThisTurn >= 6) {
        client.sendToolResponse(call.id, { error: "слишком много вызовов подряд: ответь владельцу тем, что уже известно" }, "WHEN_IDLE");
        continue;
      }
      this.toolCallsThisTurn += 1;
      const { result } = await runToolCall(def, call.args, call.id, this.toolContext());
      // Голосовая сессия должна отреагировать на результат: WHEN_IDLE (SILENT запрещает ответ).
      client.sendToolResponse(call.id, result, "WHEN_IDLE");
      if (!result.ok && "error" in result) {
        this.deps.store.event(this.deps.callId, "tool_error", { tool: def.name, args: call.args, code: result.error.code, message: result.error.message.slice(0, 300) });
      }
      if (def.cls !== "R") this.deps.store.event(this.deps.callId, "confirm", { tool: def.name });
    }
    this.setState("listening");
  }

  private wireRouter(client: LiveClient) {
    const ctx = this.toolContext();
    client.on("toolCall", (calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>) => {
      void this.handleRouterCalls(client, calls);
    });
    client.on("usage", (tokens: number) => this.pool.addUsage(tokens));
    client.on("close", (code: number) => {
      if (this.ended) return;
      if (String(code) === "429") {
        try {
          this.pool.switchOnQuota();
          this.router = this.makeRouterSession();
        } catch {
          this.frame({ type: "error", code: "quota_all_keys", message: "квота обоих ключей исчерпана", retryable: false });
        }
      } else {
        this.router = this.makeRouterSession();
      }
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
      for (const c of calls) client.sendToolResponse(c.id, { error: "превышен лимит вызовов на реплику" }, "SILENT");
      return;
    }
    this.routerBusyCount += 1;
    this.setState("working");
    const seen = new Map<string, boolean>();
    for (const call of calls) {
      const def = toolByName(call.name);
      if (!def) {
        client.sendToolResponse(call.id, { error: `неизвестный инструмент ${call.name}` }, "SILENT");
        continue;
      }
      const hash = argsHash(def.name, call.args);
      if (seen.has(hash)) {
        client.sendToolResponse(call.id, { info: "уже выполнено, больше не вызывай" }, "SILENT");
        continue;
      }
      seen.set(hash, true);
      if (def.cls === "R") {
        const { result } = await runToolCall(def, call.args, call.id, this.toolContext());
        client.sendToolResponse(call.id, result, "SILENT");
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

  private flushSystemSoon() {
    if (this.systemBatch.length === 0) return;
    const batch = this.systemBatch;
    this.systemBatch = [];
    const text = `[СИСТЕМА] ${batch.join("\n")}`.slice(0, 4000);
    this.ledger.add("tool", text);
    this.deps.store.event(this.deps.callId, "system_batch", { text: text.slice(0, 300) });
    this.voice?.sendClientContent(text, true);
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
        this.voice?.sendClientContent(`[СИСТЕМА] Скажи владельцу: ${p.say}`, true);
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
      if (this.mode === "extended") this.voice?.sendClientContent(`[СИСТЕМА] ${message}.`, true);
      return;
    }
    // Исполняет сервер немедленно (кнопка и voice в обоих режимах, спека §7.1 п. 7).
    const def = toolByName(p.tool);
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
      summary: p.say,
    });
    this.resolvePendingToolResponse(p.argsHash, result);
    // Модель узнаёт результат через вставку [СИСТЕМА] в обоих режимах:
    // в native toolResponse уже отдан как needsConfirmation, повторять его некому.
    const text = result.ok
      ? `выполнено: ${p.tool}. ${JSON.stringify(result.data).slice(0, 600)}`
      : `не выполнено: ${"error" in result ? result.error.message : "нужно подтверждение"}`;
    this.voice?.sendClientContent(`[СИСТЕМА] ${text}`, true);
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
    this.router?.sendToolResponse(wait.functionId, result, "SILENT");
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
        if (peak < 40 && bytes > 10_000) {
          this.frame({ type: "warning", code: "tpm_near_limit", message: "микрофон почти молчит: проверь, не замучен ли он в системе и в браузере" });
        }
      }, 5000);
      this.micReporter.unref?.();
    }
  }

  /** Кадр playback_drained из браузера: открывает окно подтверждения. */
  onPlaybackDrained(turnSeq: number) {
    this.gate.onPlaybackDrained(turnSeq);
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

  async switchMode(mode: "normal" | "extended") {
    if (mode === this.mode || this.ended) return;
    if (this.gate.pendingConfirmation()) {
      this.frame({ type: "error", code: "pending_confirmation", message: "дождись ответа на подтверждение", retryable: false });
      return;
    }
    this.frame({ type: "mode", mode, switching: true });
    const handle = this.voice?.sessionHandle ?? undefined;
    this.mode = mode;
    this.modeHistory.push(mode);
    this.deps.store.setModeHistory(this.deps.callId, this.modeHistory);
    this.router?.close();
    this.router = null;
    this.voice?.close();
    await this.openSessions(handle);
    // Пересказ новой сессии: тот же механизм, что смена ключа (спека §2.1).
    this.voice?.sendClientContent(`[СИСТЕМА] Разговор продолжается. Пересказ:\n${this.ledger.handoverSummary()}`, false);
    this.frame({ type: "mode", mode, switching: false });
    this.setState("listening");
  }

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnect1008 = 0;
  private reconnectAttempts = 0;
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
      const useHandle = handle === undefined ? this.voice?.sessionHandle ?? undefined : handle;
      this.voice?.close();
      try {
        await this.openSessions(useHandle);
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

  setMuted(muted: boolean) {
    this.muted = muted;
    this.setState(muted ? "muted" : "listening");
  }

  async end(reason: "owner" | "limit" | "error"): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const minutes = Math.round((Date.now() - this.startedAt) / 60000);
    const summary = `Звонок завершён (${reason === "owner" ? "по просьбе владельца" : reason === "limit" ? "лимит времени" : "ошибка"}), ${minutes} мин.`;
    try {
      await this.deps.endCallThread(summary);
    } catch {
      // Тред мог не создаться, если владелец молчал.
    }
    this.voice?.close();
    this.router?.close();
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
