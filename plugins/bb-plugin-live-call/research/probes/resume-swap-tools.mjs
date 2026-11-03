/**
 * Проба: замена инструментов через переподключение с sessionResumption и новым setup.
 * K=<ключ Gemini> node research/probes/resume-swap-tools.mjs
 * Сессия 1: инструмент alpha_ping, говорим «запомни слово КИВИ», вызываем alpha_ping, берём handle.
 * Сессия 2: тот же handle, в setup только crm_clients. Проверяем: вызывается crm_clients? alpha_ping исчез?
 * Помнит ли модель слово из сессии 1? Сколько длится переподключение?
 */
const K = process.env.K;
if (!K) throw new Error("K не задан");
const URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${K}`;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const fn = (name, description) => ({ functionDeclarations: [{ name, description, parameters: { type: "object", properties: { q: { type: "string" } } } }] });
setTimeout(() => { log("TIMEOUT"); process.exit(2); }, 120_000);

function session(tools, handle, script) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    let lastHandle = handle ?? null;
    let said = "";
    let i = 0;
    let quiet = null;
    const tOpen = Date.now();
    const step = () => {
      if (i < script.length) { const text = script[i++]; log(">>", text); ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } })); bump(); }
      else { ws.close(); resolve(lastHandle); }
    };
    const bump = () => { clearTimeout(quiet); quiet = setTimeout(step, 5000); };
    ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] }, outputAudioTranscription: {}, systemInstruction: { parts: [{ text: "Ты тестовый помощник. Отвечай коротко." }] }, tools, sessionResumption: handle ? { handle } : {} } }));
    ws.onclose = (e) => { if (e.code !== 1000 && e.code !== 1005) log("CLOSE", e.code, String(e.reason).slice(0, 200)); resolve(lastHandle); };
    ws.onmessage = async (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : Buffer.from(await ev.data.arrayBuffer()).toString("utf8");
      const m = JSON.parse(raw);
      if (m.setupComplete) { log(`setupComplete за ${Date.now() - tOpen} мс`, handle ? "(resume)" : ""); step(); return; }
      bump();
      if (m.sessionResumptionUpdate?.newHandle) lastHandle = m.sessionResumptionUpdate.newHandle;
      for (const c of m.toolCall?.functionCalls ?? []) {
        log("TOOLCALL", c.name, JSON.stringify(c.args));
        ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: c.id, name: c.name, response: { ok: true } }] } }));
      }
      if (m.serverContent?.outputTranscription?.text) said += m.serverContent.outputTranscription.text;
      if (m.serverContent?.turnComplete && said) { log("SAID", said.slice(0, 160)); said = ""; }
    };
  });
}

const h = await session([fn("alpha_ping", "Тестовый пинг")], null, ["Запомни слово КИВИ. Потом вызови alpha_ping с q='1'."]);
log("handle:", h ? "получен" : "НЕТ");
if (!h) process.exit(1);
const tSwap = Date.now();
await session([fn("crm_clients", "Список клиентов CRM")], h, [
  "Вызови crm_clients с q='все'. Только вызови.",
  "Теперь вызови alpha_ping с q='2'.",
  "Какое слово я просил запомнить?",
]);
log(`переподключение + 3 вопроса: ${Date.now() - tSwap} мс`);
process.exit(0);
