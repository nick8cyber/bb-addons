/**
 * Проба: работает ли contextUpdate (замена tools и systemInstruction посреди сессии) на AI Studio-ключе.
 * K=<ключ Gemini> node research/probes/context-update.mjs
 * 1) setup с инструментом alpha_ping; 2) просим вызвать alpha_ping → ждём toolCall;
 * 3) contextUpdate: tools = [crm_clients] + новая инструкция; 4) просим вызвать crm_clients → ждём toolCall;
 * 5) просим alpha_ping (его больше нет) → смотрим, что сделает модель.
 */
const K = process.env.K;
if (!K) throw new Error("K не задан");
const API = process.env.API || "v1beta";
const URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${API}.GenerativeService.BidiGenerateContent?key=${K}`;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const fn = (name, description) => ({ functionDeclarations: [{ name, description, parameters: { type: "object", properties: { q: { type: "string" } } } }] });
const ws = new WebSocket(URL);
let quiet = null;
const bump = () => { clearTimeout(quiet); quiet = setTimeout(next, 5000); };
let step = 0;
const say = (text) => ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }));
const next = () => {
  step++;
  if (step === 1) say("Вызови инструмент alpha_ping с q='1'. Только вызови.");
  if (step === 2) {
    log("→ contextUpdate");
    ws.send(JSON.stringify({ contextUpdate: process.env.WITH_SI ? { tools: { tools: [fn("crm_clients", "Список клиентов CRM")] }, systemInstruction: { parts: [{ text: "Ты помощник по CRM. Отвечай очень коротко." }] } } : { tools: { tools: [fn("crm_clients", "Список клиентов CRM")] } } }));
    setTimeout(() => { say("Вызови инструмент crm_clients с q='все'. Только вызови."); bump(); }, 3000);
  }
  if (step === 3) say("Теперь вызови инструмент alpha_ping с q='2'.");
  if (step === 4) { log("DONE"); process.exit(0); }
};
setTimeout(() => { log("TIMEOUT step", step); process.exit(2); }, 90_000);
ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] }, outputAudioTranscription: {}, systemInstruction: { parts: [{ text: "Ты тестовый помощник." }] }, tools: [fn("alpha_ping", "Тестовый пинг")] } }));
ws.onclose = (e) => { log("CLOSE", e.code, String(e.reason).slice(0, 200)); process.exit(3); };
let said = "";
let pending = null;
ws.onmessage = async (ev) => {
  const raw = typeof ev.data === "string" ? ev.data : Buffer.from(await ev.data.arrayBuffer()).toString("utf8");
  const m = JSON.parse(raw);
  if (m.setupComplete) { log("setupComplete", API); next(); return; }
  bump();
  if (m.toolCall) {
    for (const c of m.toolCall.functionCalls ?? []) {
      log("TOOLCALL", c.name, JSON.stringify(c.args));
      ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: c.id, name: c.name, response: { ok: true } }] } }));
    }
  }
  if (m.serverContent?.outputTranscription?.text) said += m.serverContent.outputTranscription.text;
  if (m.serverContent?.turnComplete) { if (said) log("SAID", said.slice(0, 160)); said = ""; }
  if (m.error || m.goAway) log("SERVER", raw.slice(0, 300));
};
