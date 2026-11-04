/**
 * Живая проверка: после «Завершить» хост освобождается сразу (событие ending).
 * node research/probes/end-release-check.mjs — звонок → end → сразу второй hello → ждём ready, не busy → end.
 * Запускать фоном; перед — bb call status.
 */
const WS_URL = "ws://127.0.0.1:38886/api/v1/plugins/live-call/http/call";
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a);
setTimeout(() => { log("TIMEOUT"); process.exit(2); }, 40_000);
const open = (name, onFrame) => {
  const ws = new WebSocket(WS_URL);
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", protocol: 1 }));
  ws.onmessage = (ev) => { if (typeof ev.data === "string") onFrame(ws, JSON.parse(ev.data)); };
  ws.onclose = (e) => log(name, "close", e.code, e.reason);
  return ws;
};
open("A", (a, f) => {
  if (f.type === "ready") { log("A ready", f.callId); setTimeout(() => { log("A end"); a.send(JSON.stringify({ type: "end" })); }, 2000); }
  if (f.type === "ended") {
    log("A ended", f.reason);
    a.close();
    open("B", (b, g) => {
      if (g.type === "ready") { log("RESULT B ready — хост свободен", g.callId); b.send(JSON.stringify({ type: "end" })); }
      if (g.type === "error") { log("RESULT B error", g.code, g.message); process.exit(1); }
      if (g.type === "ended") { log("B ended"); setTimeout(() => process.exit(0), 500); }
    });
  }
});
