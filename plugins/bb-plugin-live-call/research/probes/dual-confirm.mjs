// Router mode + ConfirmationGate (text-level). GUARD=1: while pending, owner replies go ONLY to the gate (not ROUTER).
const W = k => `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${k}`;
const t0 = Date.now(); const log = (...a) => console.log(`@${Date.now() - t0}`.padEnd(7), ...a);
const parse = async e => JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString());
const GUARD = process.env.GUARD === "1";
const voice = new WebSocket(W(process.env.KV)), router = new WebSocket(W(process.env.KR));
let said = "", ready = 0, pending = null, answers = ["да", "запускай"], executed = 0, newPendings = 0;
const hash = a => JSON.stringify(a, Object.keys(a).sort());
const toVoice = txt => { log("INJECT→VOICE:", txt.slice(0, 110)); voice.send(JSON.stringify({ realtimeInput: { text: txt } })); };
const owner = q => { log("OWNER:", q);
  voice.send(JSON.stringify({ realtimeInput: { text: q } }));          // VOICE hears the owner
  if (!(GUARD && pending)) router.send(JSON.stringify({ realtimeInput: { text: q } })); else log("  (router skipped: pending)");
  if (pending) gate(q); };
const classifyL = q => { const w = q.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\s]/gu, "").split(/\s+/).filter(Boolean);
  if (w.some(x => ["нет", "не", "отмена", "отмени", "стоп", "подожди", "но"].includes(x))) return "cancel";
  if (w.some(x => ["запускай", "запусти", "раздай", "раздавай"].includes(x))) return "approved";
  if (w.every(x => ["да", "давай", "ок", "окей"].includes(x))) return "hint"; return "cancel"; };
const gate = q => { const v = classifyL(q); log(`GATE: «${q}» → ${v} (pending ${pending.id})`);
  if (v === "approved") { const p = pending; pending = null; executed++;
    toVoice(`[СИСТЕМА] Подтверждено и выполнено start_thread: агент запущен в проекте ${p.args.project}, тред «${p.args.task}», id thr_demo42.`); }
  else if (v === "hint") toVoice("[СИСТЕМА] «Да» не запускает агента: по правилу владельца нужен явный глагол. Попроси сказать «запускай» или «отмена».");
  else { pending = null; toVoice("[СИСТЕМА] Запуск отменён."); } };
const start = () => { if (++ready < 2) return; owner("Запусти агента в проекте A, пусть починит фоллбэк бота"); };
voice.onopen = () => voice.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live-extended-thinking",
  generationConfig: { responseModalities: ["AUDIO"], thinkingConfig: { thinkingLevel: "LOW" } }, outputAudioTranscription: {},
  systemInstruction: { parts: [{ text: "Ты голосовой координатор BB, говоришь по-русски коротко. У тебя НЕТ инструментов. Действия выполняет система и присылает сообщения [СИСТЕМА]. Если [СИСТЕМА] просит подтверждение — задай владельцу вопрос дословно по смыслу и жди. Не говори, что действие выполнено, пока [СИСТЕМА] не сообщит «выполнено». Не говори про системную ошибку." }] } } }));
router.onopen = () => router.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] },
  systemInstruction: { parts: [{ text: "Ты маршрутизатор инструментов. На реплику владельца: если нужно действие BB — вызови инструмент; иначе ничего. Ничего не объясняй." }] },
  tools: [{ functionDeclarations: [{ name: "start_thread", description: "Запустить нового агента в проекте с задачей", behavior: "NON_BLOCKING",
    parameters: { type: "OBJECT", properties: { project: { type: "STRING" }, task: { type: "STRING" } }, required: ["project", "task"] } }] }] } }));
router.onmessage = async e => { const m = await parse(e); if (m.setupComplete) return start();
  if (m.toolCall) for (const f of m.toolCall.functionCalls) { const h = hash(f.args || {});
    log(`ROUTER: ${f.name}(${JSON.stringify(f.args)})`);
    let out;
    if (pending && pending.h === h) out = "уже ждёт подтверждения, не вызывай повторно";
    else { if (pending) log(`  !! new pending replaces ${pending.id}`); newPendings++; pending = { id: "c" + newPendings, h, args: f.args }; out = "ожидает подтверждения владельца, не вызывай повторно";
      toVoice(`[СИСТЕМА] Нужно подтверждение: запустить агента в проекте ${f.args.project} с задачей «${f.args.task}». Для запуска владелец должен сказать «запускай», для отмены — «отмена».`); }
    router.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: f.id, name: f.name, response: { output: out, scheduling: "SILENT" } }] } })); } };
voice.onmessage = async e => { const m = await parse(e); if (m.setupComplete) return start(); const sc = m.serverContent; if (!sc) return;
  if (sc.outputTranscription?.text) said += sc.outputTranscription.text;
  if (sc.turnComplete) { const s = said.trim(); said = ""; if (!s) return; log(`VOICE: ${s}`);
    if (pending && /запуск|подтверд|отмен/i.test(s) && answers.length) { const a = answers.shift(); setTimeout(() => owner(a), 800); } } };
setTimeout(() => { log(`SUMMARY guard=${GUARD} executed=${executed} pendingsCreated=${newPendings}`); voice.close(); router.close(); process.exit(0); }, +(process.env.T || 40000));
