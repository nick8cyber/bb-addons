/**
 * Живая проверка обычного звонка после отключения Extended (ADR-0006, пересмотр 2).
 * node research/probes/general-call-check.mjs ["вопрос"] — кадр text, без синтеза речи.
 * Печатает режим, реплики голоса, инструменты; ищет «системная ошибка». Запускать фоном, перед — bb call status.
 */
const WS_URL = "ws://127.0.0.1:38886/api/v1/plugins/live-call/http/call";
const question = process.argv[2] || "Привет. Расскажи подробно по каждому проекту в BB, что там происходит.";
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const ws = new WebSocket(WS_URL);
let asked = false;
let lastAgent = Date.now();
let sysErr = false;
const finish = () => {
  log(`RESULT systemError=${sysErr}`);
  try { ws.send(JSON.stringify({ type: "end" })); } catch {}
  setTimeout(() => process.exit(sysErr ? 1 : 0), 2000);
};
setTimeout(finish, 150_000);
setInterval(() => { if (asked && Date.now() - lastAgent > 15_000) finish(); }, 1000);
ws.onopen = () => ws.send(JSON.stringify({ type: "hello", protocol: 1 }));
ws.onmessage = (ev) => {
  if (typeof ev.data !== "string") { lastAgent = Date.now(); return; } // аудио голоса — он ещё говорит
  const f = JSON.parse(ev.data);
  if (f.type === "transcript" && f.role === "agent") lastAgent = Date.now();
  if (f.type === "ready") {
    log("ready mode=" + f.mode, f.callId);
    setTimeout(() => { asked = true; lastAgent = Date.now(); ws.send(JSON.stringify({ type: "text", text: question })); }, 3000);
  }
  if (f.type === "transcript" && f.final && f.role === "agent") {
    lastAgent = Date.now();
    if (/системн\S* ошибк/i.test(f.text)) sysErr = true;
    log("[agent]", String(f.text).slice(0, 220));
  }
  if (f.type === "action") log("[action]", f.tool, f.status);
  if (f.type === "error") log("[error]", f.code, f.message);
};
