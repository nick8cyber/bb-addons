/**
 * Мост провайдера «Live Call» (ADR-0007): не вызывает модель, только отображает звонок.
 * Каждый ход остаётся ОТКРЫТЫМ, пока сервер плагина не скажет «end»; реплики голосового
 * агента приходят по WebSocket («say») и рендерятся как agentMessage (контракт §7).
 *
 * Подводные камни рукопожатия проверены спайком: grammarVersions ≥ 2 элементов,
 * у item.close обязателен status, неверная пачка дельт отбрасывается молча.
 */
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  experimental_defineProviderBridge,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Id = string | number;

let logFile: string | null = null;
const log = (m: string) => {
  if (logFile) {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${m}\n`);
    } catch {
      // Файл журнала недоступен — молча, журнал не критичен.
    }
  }
};
const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const ok = (id: Id, result: unknown) => write({ id, result });
const err = (id: Id, code: number, message: string) => write({ id, error: { code, message } });
const notify = (method: string, params: Record<string, unknown>) => write({ method, params });
const emit = (threadId: string, ...deltas: ThreadDelta[]) => notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });

type Session = { threadId: string; turn: string | null; n: number; items: number; openedAt: number };
const sessions = new Map<string, Session>();
let ws: WebSocket | null = null;
const outbox: string[] = [];
const toServer = (m: unknown) => {
  const s = JSON.stringify(m);
  if (ws && ws.readyState === 1) ws.send(s);
  else outbox.push(s);
};

let dataDir = "";
let pluginId = "live-call";

function connect() {
  const f = join(dataDir, "server.json");
  if (!existsSync(f)) {
    setTimeout(connect, 1000);
    return;
  }
  const base = (JSON.parse(readFileSync(f, "utf8")) as { url: string }).url;
  const url = `${base.replace(/^http/, "ws")}/api/v1/plugins/${pluginId}/http/bridge`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    log(`ws open ${url}`);
    while (outbox.length) ws!.send(outbox.shift()!);
    toServer({ type: "hello", pid: process.pid, protocol: 1 });
  };
  ws.onmessage = (e) => {
    try {
      onServer(JSON.parse(String(e.data)));
    } catch (x) {
      log(`bad server msg ${String(x)}`);
    }
  };
  ws.onclose = () => {
    ws = null;
    setTimeout(connect, 1000);
  };
  ws.onerror = () => log("ws error");
}

function openTurn(s: Session, clientRequestId?: string) {
  s.n += 1;
  s.turn = `${s.threadId}_t${s.n}`;
  s.openedAt = Date.now();
  const d: ThreadDelta[] = [{ kind: "turn.open", providerTurnId: s.turn } as ThreadDelta];
  if (clientRequestId) d.push({ kind: "input.accepted", clientRequestId, providerTurnId: s.turn } as ThreadDelta);
  emit(s.threadId, ...d);
}

function say(s: Session, text: string) {
  if (!s.turn) {
    log(`say without open turn on ${s.threadId}`);
    return;
  }
  s.items += 1;
  const key = { providerItemId: `${s.turn}_i${s.items}` };
  emit(
    s.threadId,
    { kind: "item.open", providerTurnId: s.turn, key, item: { type: "agentMessage", text: "" } } as ThreadDelta,
    { kind: "item.textDelta", providerTurnId: s.turn, key, channel: "agentMessage", text } as ThreadDelta,
    { kind: "item.close", providerTurnId: s.turn, key, status: "completed", item: { type: "agentMessage", text } } as ThreadDelta,
  );
}

function endTurn(s: Session, status: "completed" | "interrupted" = "completed") {
  if (!s.turn) return;
  log(`turn ${s.turn} ${status} after ${Math.round((Date.now() - s.openedAt) / 1000)}s`);
  emit(s.threadId, { kind: "turn.boundary", providerTurnId: s.turn, status } as ThreadDelta);
  s.turn = null;
  toServer({ type: "turn_closed", threadId: s.threadId, providerTurnId: s.turn, status });
}

function onServer(m: { type: string; threadId?: string; text?: string }) {
  const s = m.threadId ? sessions.get(m.threadId) : undefined;
  if (!s) {
    log(`server ${m.type} for unknown thread ${m.threadId}`);
    return;
  }
  if (m.type === "say" && m.text) say(s, m.text);
  if (m.type === "end") endTurn(s);
}

const textOf = (input: unknown) =>
  Array.isArray(input) ? input.map((p: { text?: string }) => p?.text ?? "").join(" ") : "";

function startSession(threadId: string) {
  const s: Session = { threadId, turn: null, n: 0, items: 0, openedAt: 0 };
  sessions.set(threadId, s);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId, providerThreadId: `lc_${threadId}`, sessionRestorable: true });
  emit(threadId, { kind: "session.reset" } as ThreadDelta);
  return s;
}

const HEALTH_STATUS = (process.env.LC_HEALTH ?? "not_installed") as string;

const handlers: Record<string, (id: Id, p: Record<string, unknown>) => void> = {
  ["provider/health"]: (id) => {
    // Схема ответа — дискриминированное объединение по supported (лог сервера: «Invalid discriminator value»).
    ok(id, {
      supported: true,
      health: {
        accountEmail: null,
        canInstall: false,
        canUpdate: false,
        installedVersion: HEALTH_STATUS === "ready" ? "0.1.0" : null,
        loginCommand: null,
        minimumSupportedVersion: null,
        planLabel: null,
        status: HEALTH_STATUS,
        statusMessage: "звонки создаются кнопкой 📞",
      },
    });
  },
  [BRIDGE_REQUEST_METHODS.initialize]: (id) =>
    ok(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "runtime",
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        steerMode: "queue",
      },
    }),
  [BRIDGE_REQUEST_METHODS.modelList]: (id) =>
    ok(id, {
      models: [
        {
          id: "live",
          model: "live",
          displayName: "Live",
          description: "Запись голосового звонка",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
      selectedOnlyModels: [],
    }),
  [BRIDGE_REQUEST_METHODS.threadStart]: (id, p) => {
    const threadId = String(p.threadId ?? "");
    const s = startSession(threadId);
    ok(id, { providerThreadId: `lc_${threadId}`, sessionRestorable: true });
    toServer({ type: "own", threadId });
    const text = textOf(p.input);
    if (text) {
      openTurn(s);
      toServer({ type: "turn", threadId, text, first: true });
    }
  },
  [BRIDGE_REQUEST_METHODS.threadResume]: (id, p) => {
    const threadId = String(p.threadId ?? "");
    startSession(threadId);
    ok(id, { providerThreadId: `lc_${threadId}`, sessionRestorable: true });
    toServer({ type: "own", threadId });
  },
  [BRIDGE_REQUEST_METHODS.turnStart]: (id, p) => {
    const threadId = String(p.threadId ?? "");
    const s = sessions.get(threadId);
    if (!s) {
      err(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "нет сессии треда");
      return;
    }
    ok(id, {});
    // Открытый ход закрывается ради следующего (контракт §7: turn_closed по new turn).
    if (s.turn) endTurn(s, "interrupted");
    openTurn(s, p.clientRequestId as string | undefined);
    toServer({ type: "turn", threadId, text: textOf(p.input) });
  },
  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, _p) => {
    err(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "steer не поддерживается: реплика владельца начинается новый ход");
  },
  [BRIDGE_REQUEST_METHODS.threadStop]: (id, p) => {
    const threadId = String(p.threadId ?? "");
    const s = sessions.get(threadId);
    if (s && p.intent === "interrupt") endTurn(s, "interrupted");
    sessions.delete(threadId);
    ok(id, {});
  },
};

export function handleLine(line: string) {
  let m: { method?: unknown; id?: unknown; params?: Record<string, unknown> };
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (!m || typeof m.method !== "string") return;
  if (typeof m.id !== "string" && typeof m.id !== "number") return;
  const h = handlers[m.method];
  log(`<- ${m.method}`);
  if (!h) {
    err(m.id as Id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${m.method}`);
    return;
  }
  try {
    h(m.id as Id, m.params ?? {});
  } catch (e) {
    err(m.id as Id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, String(e));
  }
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(ctx) {
    dataDir = ctx.dataDir;
    logFile = join(ctx.dataDir, "bridge.log");
    log(`start pid=${process.pid} dataDir=${ctx.dataDir}`);
    connect();
  },
  onClose() {
    log("stdin closed");
  },
});
