/**
 * Живая проверка изоляции мозгового центра (§12.11 п.1).
 * node research/probes/brain-isolation-check.mjs <testThreadId>
 * Звонок по тестовому треду → ждёт сводку → brain_task «создай test-brain.txt» → approve →
 * пока звонок идёт: файл есть в worktree мозгового центра и нет в папке целевого треда → удаляет файл → конец звонка.
 * Запускать только фоном; перед запуском — bb call status.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const target = process.argv[2];
if (!target) throw new Error("usage: brain-isolation-check.mjs <testThreadId>");
const WS_URL = "ws://127.0.0.1:38886/api/v1/plugins/live-call/http/call";
const DB = join(homedir(), ".bb/plugins/live-call/data.db");
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
const envPath = (threadId) => {
  const m = /Path:\s*(\S+)/.exec(sh("bb", ["environment", "show", /Environment:.*\((env_[a-z0-9]+)\)/.exec(sh("bb", ["thread", "show", threadId]))[1]]));
  return m ? m[1] : null;
};

const ws = new WebSocket(WS_URL);
let callId = null;
let asked = false;
let taskStart = 0;
const finish = (code) => {
  try { ws.send(JSON.stringify({ type: "end" })); } catch {}
  setTimeout(() => process.exit(code), 3000);
};
setTimeout(() => { log("TIMEOUT"); finish(2); }, 240_000);

ws.onopen = () => ws.send(JSON.stringify({ type: "hello", protocol: 1, mode: "normal", threadId: target }));
ws.onmessage = (ev) => {
  if (typeof ev.data !== "string") return;
  const f = JSON.parse(ev.data);
  if (f.type === "ready") { callId = f.callId; log("ready", callId); }
  if (f.type === "transcript" && f.final) log(`[${f.role}]`, String(f.text).slice(0, 160));
  if (f.type === "action") log("[action]", f.tool, f.status, String(f.summary ?? "").slice(0, 100));
  if (f.type === "error") log("[error]", f.code, f.message);
  if (!asked && callId) {
    const summ = sh("sqlite3", [DB, `select count(*) from call_events where call_id='${callId}' and kind='brain_summary'`]).trim();
    if (summ !== "0") {
      asked = true;
      log("summary ready → brain_task");
      ws.send(JSON.stringify({ type: "text", text: "Поставь задачу мозговому центру: создай файл test-brain.txt с текстом ok" }));
    }
  }
  if (f.type === "confirmation") {
    log("[confirmation]", f.say ?? f.summary);
    taskStart = Date.now();
    setTimeout(() => ws.send(JSON.stringify({ type: "confirm", confirmationId: f.confirmationId, decision: "approve" })), 1000);
  }
  if (f.type === "action" && f.tool === "brain_task" && (f.status === "done" || f.status === "failed")) {
    log(`brain_task ${f.status} за ${((Date.now() - taskStart) / 1000).toFixed(1)} с`);
    const brainId = sh("sqlite3", [DB, `select json_extract(payload,'$.threadId') from call_events where call_id='${callId}' and kind='brain_started'`]).trim();
    const brainDir = envPath(brainId);
    const targetDir = envPath(target);
    let n = 0;
    const iv = setInterval(() => {
      n++;
      const st = sh("bb", ["thread", "show", brainId]).match(/Status:\s*(\S+)/)?.[1];
      const inBrain = brainDir ? existsSync(join(brainDir, "test-brain.txt")) : false;
      if (!(inBrain && st === "idle") && n < 24) return;
      clearInterval(iv);
      const inTarget = targetDir ? existsSync(join(targetDir, "test-brain.txt")) : false;
      log(`brain ${brainId} status=${st} done_after=${((Date.now() - taskStart) / 1000).toFixed(1)}s dir=${brainDir} target=${targetDir}`);
      log(`RESULT file in brain worktree: ${inBrain}; file in target folder: ${inTarget}; same dir: ${brainDir === targetDir}`);
      if (inBrain) rmSync(join(brainDir, "test-brain.txt"));
      if (inTarget) rmSync(join(targetDir, "test-brain.txt"));
      finish(inBrain && !inTarget && brainDir !== targetDir ? 0 : 1);
    }, 5000);
  }
};
