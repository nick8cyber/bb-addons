// Router = second Live session on gemini-3.8-live with native tools; modality from env (TEXT or AUDIO).
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.K}`;
const ws = new WebSocket(url); const t0 = Date.now(); const log = (...a) => console.log(`@${Date.now() - t0}`, ...a);
const qs = ["Какие у меня сейчас активные треды?", "Что там с бот-Aом, он закончил?", "Напиши в тред проект B, чтобы прогнал тесты", "Как думаешь, стоит ли нам переходить на Bun?"];
let i = 0, tq = 0, timer;
const next = () => { clearTimeout(timer); if (i >= qs.length) { ws.close(); return; } tq = Date.now(); const q = qs[i++];
  log("Q", q); ws.send(JSON.stringify({ realtimeInput: { text: q } })); timer = setTimeout(() => { log("  → no tool (6s)"); next(); }, 6000); };
ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live",
  generationConfig: { responseModalities: [process.env.MOD || "TEXT"] },
  systemInstruction: { parts: [{ text: "Ты маршрутизатор инструментов. На каждую реплику владельца: если нужно действие или данные BB — вызови инструмент; иначе ответь одним словом NONE. Ничего не объясняй." }] },
  tools: [{ functionDeclarations: [
    { name: "list_threads", description: "Список тредов BB", behavior: "NON_BLOCKING", parameters: { type: "OBJECT", properties: { status: { type: "STRING" } } } },
    { name: "read_thread", description: "Статус и последний ответ треда", behavior: "NON_BLOCKING", parameters: { type: "OBJECT", properties: { thread: { type: "STRING" } }, required: ["thread"] } },
    { name: "send_to_thread", description: "Отправить сообщение в тред", behavior: "NON_BLOCKING", parameters: { type: "OBJECT", properties: { thread: { type: "STRING" }, text: { type: "STRING" } }, required: ["thread", "text"] } } ] }] } }));
ws.onmessage = async (e) => { const m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString());
  if (m.setupComplete) { log("setupComplete"); next(); return; }
  if (m.toolCall) { const fcs = m.toolCall.functionCalls; log(`  → ${Date.now() - tq}ms`, fcs.map(f => `${f.name}(${JSON.stringify(f.args)})`).join(", "));
    ws.send(JSON.stringify({ toolResponse: { functionResponses: fcs.map(f => ({ id: f.id, name: f.name, response: { output: "accepted" , scheduling: "SILENT" } })) } })); setTimeout(next, 300); return; }
  const parts = m.serverContent?.modelTurn?.parts || []; for (const p of parts) if (p.text) log("  text:", p.text.slice(0, 60));
  if (m.serverContent?.turnComplete && Date.now() - tq > 0) { /* text answer done */ }
};
ws.onclose = (e) => { log("close", e.code, e.reason); process.exit(0); };
setTimeout(() => process.exit(0), 45000);
