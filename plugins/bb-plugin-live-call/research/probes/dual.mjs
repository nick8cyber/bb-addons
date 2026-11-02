// Dual session: VOICE = extended thinking (no tools), ROUTER = gemini-3.8-live with native tools. Server injects results into VOICE.
const W = k => `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${k}`;
const t0 = Date.now(); const log = (...a) => console.log(`@${Date.now() - t0}`.padEnd(7), ...a);
const parse = async e => JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString());
const FAKE = {
  list_threads: () => "Активны 3 треда: «бот-A: фикс фоллбэка» — работает 12 мин; «проект B: миграция БД» — ждёт ответа владельца на вопрос, какую схему брать; «BB voice» — idle, закончил 5 мин назад.",
  read_thread: a => `Тред «${a.thread}»: закончил, последний ответ — «тесты зелёные, 142 из 142, коммит a1b2c3 в ветке fix/fallback, жду слова на push».`,
  send_to_thread: a => `Сообщение «${a.text}» отправлено в тред «${a.thread}», агент принял в работу.`,
};
const voice = new WebSocket(W(process.env.KV)), router = new WebSocket(W(process.env.KR));
let said = "", ready = 0, tq = 0, calls = 0; const seen = new Set();
const start = () => { if (++ready < 2) return; ask(process.env.Q || "Какие у меня сейчас активные треды и что из них ждёт меня?"); };
const ask = q => { tq = Date.now(); log("USER:", q); voice.send(JSON.stringify({ realtimeInput: { text: q } })); router.send(JSON.stringify({ realtimeInput: { text: q } })); };
voice.onopen = () => voice.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live-extended-thinking",
  generationConfig: { responseModalities: ["AUDIO"], thinkingConfig: { thinkingLevel: "LOW" }, speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
  outputAudioTranscription: {},
  systemInstruction: { parts: [{ text: "Ты голосовой координатор BB, говоришь с владельцем по-русски, коротко, сначала главное. У тебя НЕТ инструментов и ты их не вызываешь. Действия и данные BB выполняет система автоматически по словам владельца и присылает тебе сообщения, начинающиеся с [СИСТЕМА]. Если владелец просит данные или действие — коротко скажи, что смотришь, и жди [СИСТЕМА]. Никогда не говори про системную ошибку, не выдумывай данные до [СИСТЕМА]. Получив [СИСТЕМА] — доложи суть своими словами и подскажи, что требует решения владельца." }] } } }));
router.onopen = () => router.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] },
  systemInstruction: { parts: [{ text: "Ты маршрутизатор инструментов. На каждую реплику владельца: если нужно действие или данные BB — вызови инструмент. Можно цепочкой: сначала list_threads, потом read_thread по найденному треду. Каждый инструмент — не больше одного раза на реплику. Если инструмент не нужен — ничего не делай. Ничего не объясняй." }] },
  tools: [{ functionDeclarations: [
    { name: "list_threads", description: "Список тредов BB с их статусом", behavior: "NON_BLOCKING", parameters: { type: "OBJECT", properties: { status: { type: "STRING" } } } },
    { name: "read_thread", description: "Статус и последний ответ конкретного треда", behavior: "NON_BLOCKING", parameters: { type: "OBJECT", properties: { thread: { type: "STRING" } }, required: ["thread"] } },
    { name: "send_to_thread", description: "Отправить сообщение в тред", behavior: "NON_BLOCKING", parameters: { type: "OBJECT", properties: { thread: { type: "STRING" }, text: { type: "STRING" } }, required: ["thread", "text"] } } ] }] } }));
router.onmessage = async e => { const m = await parse(e); if (m.setupComplete) return start();
  if (m.toolCall) for (const f of m.toolCall.functionCalls) {
    const sig = f.name + JSON.stringify(f.args || {}); const result = FAKE[f.name]?.(f.args || {}) ?? "нет данных";
    if (seen.has(sig) || calls >= 3) { log(`ROUTER: drop ${f.name} (dup/cap)`); router.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: f.id, name: f.name, response: { output: "уже выполнено, результат передан; больше не вызывай для этой реплики", scheduling: "SILENT" } }] } })); continue; }
    seen.add(sig); calls++;
    log(`ROUTER: ${f.name}(${JSON.stringify(f.args)}) +${Date.now() - tq}ms`);
    router.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: f.id, name: f.name, response: { output: result, scheduling: "SILENT" } }] } }));
    voice.send(JSON.stringify({ realtimeInput: { text: `[СИСТЕМА] Результат ${f.name}: ${result}` } })); log("INJECT →voice");
  } };
voice.onmessage = async e => { const m = await parse(e); if (m.setupComplete) return start(); const sc = m.serverContent; if (!sc) return;
  if (sc.outputTranscription?.text) { if (!said) log(`VOICE first words +${Date.now() - tq}ms`); said += sc.outputTranscription.text; }
  if (sc.turnComplete) { log(`VOICE turn (${sc.interactionStatus || "-"}): ${said.trim()}`); said = ""; } };
voice.onclose = e => { if (e.code !== 1000) log("voice close", e.code, e.reason); };
router.onclose = e => { if (e.code !== 1000) log("router close", e.code, e.reason); };
setTimeout(() => { voice.close(); router.close(); process.exit(0); }, +(process.env.T || 30000));
