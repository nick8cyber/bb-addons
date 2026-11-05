/**
 * Spike bridge: calls no model. Each turn stays OPEN until the plugin server says "end";
 * the server pushes the voice agent's lines over a WebSocket ("say"), the bridge renders them as agentMessage items.
 */
import {
  BRIDGE_JSON_RPC_ERRORS, BRIDGE_NOTIFICATION_METHODS, BRIDGE_REQUEST_METHODS, PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_NOTIFICATION_METHOD, experimental_defineProviderBridge, type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Id = string | number;
let logFile: string | null = null;
const log = (m: string) => { if (logFile) try { appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${m}\n`); } catch {} };
const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: Id, result: unknown) => write({ id, result });
const err = (id: Id, code: number, message: string) => write({ id, error: { code, message } });
const notify = (method: string, params: Record<string, unknown>) => write({ method, params });
const emit = (threadId: string, ...deltas: ThreadDelta[]) => notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });

type Session = { threadId: string; turn: string | null; n: number; items: number; openedAt: number };
const sessions = new Map<string, Session>();
let ws: WebSocket | null = null; const outbox: string[] = [];
const toServer = (m: unknown) => { const s = JSON.stringify(m); if (ws && ws.readyState === 1) ws.send(s); else outbox.push(s); };

let dataDir = "";
function connect() {
  const f = join(dataDir, "server.json");
  if (!existsSync(f)) { log("server.json not yet written; retry in 1s"); setTimeout(connect, 1000); return; }
  const base = JSON.parse(readFileSync(f, "utf8")).url as string;
  const url = base.replace(/^http/, "ws") + "/api/v1/plugins/live-call-spike/http/bridge";
  ws = new WebSocket(url);
  ws.onopen = () => { log(`ws open ${url}`); while (outbox.length) ws!.send(outbox.shift()!); toServer({ type: "hello", pid: process.pid }); };
  ws.onmessage = (e) => { try { onServer(JSON.parse(String(e.data))); } catch (x) { log(`bad server msg ${String(x)}`); } };
  ws.onclose = (e) => { log(`ws close ${e.code} ${e.reason}`); ws = null; setTimeout(connect, 1000); };
  ws.onerror = () => log("ws error");
}

function openTurn(s: Session, clientRequestId?: string) {
  s.n += 1; s.turn = `${s.threadId}_t${s.n}`; s.openedAt = Date.now();
  const d: ThreadDelta[] = [{ kind: "turn.open", providerTurnId: s.turn } as ThreadDelta];
  if (clientRequestId) d.push({ kind: "input.accepted", clientRequestId, providerTurnId: s.turn } as ThreadDelta);
  emit(s.threadId, ...d);
}
function say(s: Session, text: string) {
  if (!s.turn) { log(`say without open turn on ${s.threadId}`); return; }
  s.items += 1; const key = { providerItemId: `${s.turn}_i${s.items}` };
  emit(s.threadId,
    { kind: "item.open", providerTurnId: s.turn, key, item: { type: "agentMessage", text: "" } } as ThreadDelta,
    { kind: "item.textDelta", providerTurnId: s.turn, key, channel: "agentMessage", text } as ThreadDelta,
    { kind: "item.close", providerTurnId: s.turn, key, status: "completed", item: { type: "agentMessage", text } } as ThreadDelta);
  log(`say ok ${key.providerItemId}: ${text.slice(0, 40)}`);
}
function endTurn(s: Session, status: "completed" | "interrupted" = "completed") {
  if (!s.turn) return; log(`turn ${s.turn} ${status} after ${Math.round((Date.now() - s.openedAt) / 1000)}s`);
  emit(s.threadId, { kind: "turn.boundary", providerTurnId: s.turn, status } as ThreadDelta); s.turn = null;
}
function onServer(m: { type: string; threadId?: string; text?: string }) {
  const s = m.threadId ? sessions.get(m.threadId) : undefined;
  if (!s) { log(`server ${m.type} for unknown thread ${m.threadId}`); return; }
  if (m.type === "say" && m.text) say(s, m.text);
  if (m.type === "end") endTurn(s);
}
const textOf = (input: unknown) => Array.isArray(input) ? input.map((p: any) => p?.text ?? "").join(" ") : "";

function startSession(threadId: string) {
  const s: Session = { threadId, turn: null, n: 0, items: 0, openedAt: 0 }; sessions.set(threadId, s);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId, providerThreadId: `lc_${threadId}`, sessionRestorable: true });
  emit(threadId, { kind: "session.reset" } as ThreadDelta);
  return s;
}

const HEALTH = (process.env.LC_HEALTH ?? "not_installed") as string;
const handlers: Record<string, (id: Id, p: any) => void> = {
  ["provider/health"]: (id) => { log(`provider/health -> ${HEALTH}`); ok(id, { health: { accountEmail: null, canInstall: false, canUpdate: false, installedVersion: HEALTH === "ready" ? "0.0.1" : null, loginCommand: null, minimumSupportedVersion: null, planLabel: null, status: HEALTH, statusMessage: "spike" } }); },
  [BRIDGE_REQUEST_METHODS.initialize]: (id) => ok(id, { protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: {
    sessionRestore: true, threadArchive: false, threadRename: false, threadGoalClear: false, fork: "none",
    approvalEnforcedBy: "runtime", grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3], steerMode: "queue" } }),
  [BRIDGE_REQUEST_METHODS.modelList]: (id) => ok(id, { models: [{ id: "live", model: "live", displayName: "Live", description: "", supportedReasoningEfforts: [], defaultReasoningEffort: "medium", isDefault: true }], selectedOnlyModels: [] }),
  [BRIDGE_REQUEST_METHODS.threadStart]: (id, p) => {
    log(`thread/start ${p?.threadId} input="${textOf(p?.input).slice(0, 80)}"`);
    const s = startSession(p.threadId);
    ok(id, { providerThreadId: `lc_${p.threadId}`, sessionRestorable: true }); toServer({ type: "own", threadId: p.threadId });
    if (p.input?.length) { openTurn(s); toServer({ type: "turn", threadId: p.threadId, text: textOf(p.input), first: true }); }
  },
  [BRIDGE_REQUEST_METHODS.threadResume]: (id, p) => { log(`thread/resume ${p?.threadId}`); startSession(p.threadId); ok(id, { providerThreadId: `lc_${p.threadId}`, sessionRestorable: true }); },
  [BRIDGE_REQUEST_METHODS.turnStart]: (id, p) => {
    const s = sessions.get(p?.threadId); if (!s) { err(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "no session"); return; }
    log(`turn/start ${p.threadId} "${textOf(p.input).slice(0, 80)}"`);
    ok(id, {}); if (s.turn) endTurn(s); openTurn(s, p.clientRequestId); toServer({ type: "turn", threadId: p.threadId, text: textOf(p.input) });
  },
  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, p) => { log(`turn/steer ${p?.threadId}`); err(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "steer not supported in spike"); },
  [BRIDGE_REQUEST_METHODS.threadStop]: (id, p) => { const s = sessions.get(p?.threadId); log(`thread/stop ${p?.threadId} ${p?.intent}`);
    if (s && p.intent === "interrupt") endTurn(s, "interrupted"); sessions.delete(p?.threadId); ok(id, {}); },
};

export function handleLine(line: string) {
  let m: any; try { m = JSON.parse(line); } catch { return; }
  if (!m || typeof m.method !== "string") return;
  if (typeof m.id !== "string" && typeof m.id !== "number") return;
  const h = handlers[m.method]; log(`<- ${m.method}`);
  if (!h) { err(m.id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${m.method}`); return; }
  try { h(m.id, m.params); } catch (e) { err(m.id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, String(e)); }
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(ctx) { dataDir = ctx.dataDir; logFile = join(ctx.dataDir, "bridge.log"); log(`start pid=${process.pid} dataDir=${ctx.dataDir}`); connect(); },
  onClose() { log("stdin closed"); },
});
