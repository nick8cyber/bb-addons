/**
 * Живая проверка звонка по треду (кадр text, без синтеза речи).
 * node research/probes/thread-call-check.mjs <threadId> "<реплика1>|<реплика2>|..."
 * PROJECT=1 — первый аргумент projectId, звонок по проекту (§15).
 * Печатает реплики, карточки подтверждения (summary), действия; на подтверждение жмёт «Подтвердить».
 * В конце — «Завершить» и время до кадра ended. Запускать фоном; перед — bb call status.
 */
import { execSync } from "node:child_process";
const TOKEN = process.env.LC_TOKEN ?? execSync("bb call token", { encoding: "utf8" }).trim(); // §16.2
const target = process.argv[2];
const lines = (process.argv[3] ?? "Что спрашивает агент?").split("|");
if (!target) throw new Error("usage: thread-call-check.mjs <threadId> \"a|b\"");
const WS_URL = "ws://127.0.0.1:38886/api/v1/plugins/live-call/http/call";
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const ws = new WebSocket(WS_URL);
let i = 0, lastAgent = Date.now(), endAt = 0, ready = false;
const next = () => {
  if (i < lines.length) { const t = lines[i++]; log(">> владелец:", t); lastAgent = Date.now(); ws.send(JSON.stringify({ type: "text", text: t })); }
  else if (!endAt) { endAt = Date.now(); log(">> Завершить"); ws.send(JSON.stringify({ type: "end" })); }
};
setTimeout(() => { log("TIMEOUT"); process.exit(2); }, 300_000);
setInterval(() => { if (ready && !endAt && Date.now() - lastAgent > 14_000) next(); }, 1000);
ws.onopen = () => ws.send(JSON.stringify({ type: "hello", protocol: 1, token: TOKEN, ...(process.env.PROJECT ? { projectId: target } : { threadId: target }) }));
ws.onmessage = (ev) => {
  if (typeof ev.data !== "string") { lastAgent = Date.now(); return; }
  const f = JSON.parse(ev.data);
  if (f.type === "ready") { ready = true; log("ready", f.callId); }
  if (f.type === "transcript" && f.final && f.role === "agent") { lastAgent = Date.now(); log("[голос]", String(f.text).slice(0, 300)); }
  if (f.type === "action") { lastAgent = Date.now(); log("[действие]", f.tool, f.status, String(f.summary ?? "").slice(0, 120)); }
  if (f.type === "confirmation" && f.phase === "asking") {
    log("[карточка]", JSON.stringify(f.summary), "слово:", f.word);
    setTimeout(() => ws.send(JSON.stringify({ type: "confirm", confirmationId: f.confirmationId, decision: "approve" })), 1500);
  }
  if (f.type === "error") log("[ошибка]", f.code, f.message);
  if (f.type === "ended") { log(`ended ${f.reason} через ${((Date.now() - endAt) / 1000).toFixed(2)} с после «Завершить»`); setTimeout(() => process.exit(0), 500); }
};
