// Живой e2e пробник серверного контура live-call (без браузера):
// 1) базовая модель озвучивает фразу-просьбу (TTS) → PCM 24 кГц;
// 2) ресемпл в 16 кГц, подача в WS /call как микрофон;
// 3) ожидаем: ready → transcript(owner) → toolCall(list_threads) → transcript(agent) с реальными данными BB → аудио.
// Запуск: node research/probes/live-e2e.mjs [фраза]
// Ключ для TTS — из настроек плагина не берём (секрет); TTS-ключ передаётся env TTS_KEY.
const phrase = process.argv[2] ?? "Какие сейчас активные треды в BB? Ответь коротко, по пунктам.";
const TTS_KEY = process.env.TTS_KEY ?? "";
const BB_BASE = process.env.BB_BASE ?? "http://127.0.0.1:38886";
const PLUGIN_ID = "live-call";

const parse = async (e) => JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString());

const tts = () => new Promise((res, rej) => {
  const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${TTS_KEY}`);
  const bufs = [];
  ws.onopen = () => {
    console.error("[tts] open");
    ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] },
      systemInstruction: { parts: [{ text: "Произнеси текст пользователя вслух дословно, ничего не добавляй." }] } } }));
  };
  ws.onmessage = async (e) => {
    const m = await parse(e);
    if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text: phrase } }));
    if (m.error) { console.error("[tts] error:", JSON.stringify(m.error).slice(0, 200)); rej(new Error("tts setup error")); }
    for (const p of m.serverContent?.modelTurn?.parts || []) if (p.inlineData) bufs.push(Buffer.from(p.inlineData.data, "base64"));
    if (m.serverContent?.turnComplete || m.serverContent?.generationComplete) { ws.close(); res(Buffer.concat(bufs)); }
  };
  ws.onclose = (e) => { console.error(`[tts] close ${e.code}`); if (bufs.length === 0) rej(new Error(`tts closed ${e.code}`)); };
  ws.onerror = () => rej(new Error("tts ws error"));
  setTimeout(() => { try { ws.close(); } catch {} rej(new Error("tts timeout")); }, 20_000).unref();
});

const pcm24 = await tts();
const s24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2);
const n16 = Math.floor((s24.length * 2) / 3);
const s16 = new Int16Array(n16);
for (let i = 0; i < n16; i++) {
  const x = i * 1.5, j = Math.floor(x), f = x - j;
  s16[i] = (s24[j] * (1 - f) + (s24[j + 1] ?? s24[j]) * f) | 0;
}
console.log(`[tts] фраза ${(s16.length / 16000).toFixed(2)} c, ${n16} сэмплов 16 кГц`);

const t0 = Date.now();
const log = (...a) => console.log(`@${String(Date.now() - t0).padStart(6)}`, ...a);

const wsUrl = `${BB_BASE.replace(/^http/, "ws")}/api/v1/plugins/${PLUGIN_ID}/http/call`;
const ws = new WebSocket(wsUrl, { headers: { Origin: BB_BASE } });
let inTranscript = "";
let outTranscript = "";
let gotAudio = 0;
let gotReady = false;
let agentLine = "";

const frame = (pcm) => {
  const out = new Uint8Array(5 + pcm.byteLength);
  out[0] = 0x01;
  new DataView(out.buffer).setUint32(1, 0, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 5);
  return out;
};

ws.onopen = () => {
  log("ws open → hello");
  ws.send(JSON.stringify({ type: "hello", protocol: 1 }));
};
ws.onmessage = async (e) => {
  const d = e.data;
  const isBinary = typeof d !== "string";
  if (isBinary) {
    let view;
    if (d instanceof ArrayBuffer) view = new Uint8Array(d);
    else if (d instanceof Uint8Array) view = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    else if (d instanceof Blob) { const b = Buffer.from(await d.arrayBuffer()); view = new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
    else return;
    if (view[0] === 0x02) gotAudio += view.byteLength - 5;
    return;
  }
  const m = await parse(e);
  switch (m.type) {
    case "ready":
      gotReady = true;
      log("READY", `mode=${m.mode} voice=${m.voice} keys=${m.keys.active}/${m.keys.of}`);
      // Тишина 0.5 c, фраза, тишина 1.2 c для VAD — кадры по 20 мс (640 байт).
      const silence = new Int16Array(16000);
      const all = new Int16Array(silence.length / 2 + s16.length + silence.length);
      let at = 0;
      const put = (arr) => { all.set(arr, at); at += arr.length; };
      put(silence.subarray(0, 8000));
      put(s16);
      put(silence.subarray(0, 16000));
      let i = 0;
      let sent = 0;
      const tick = setInterval(() => {
        if (i >= all.length) { clearInterval(tick); log(`аудио отправлено: ${sent} кадров`); return; }
        const chunk = all.subarray(i, i + 320);
        i += 320;
        try { ws.send(frame(chunk)); sent += 1; } catch (e) { log(`send error: ${e.message}`); clearInterval(tick); }
      }, 20);
      break;
    case "thread":
      log("THREAD создан:", m.threadId);
      break;
    case "state":
      if (m.state !== "listening" || m.detail) log("state:", m.state, m.detail ?? "");
      break;
    case "transcript":
      if (m.role === "owner") inTranscript += m.text;
      else if (m.final) { /* финальный кадр несёт полный текст, не прибавляем */ }
      else {
        outTranscript += m.text;
        if (m.text) process.stdout.write(`[A]${m.text}`);
      }
      if (m.final) {
        if (m.role === "agent") {
          agentLine = m.text.trim();
          log(`transcript[agent] final: ${agentLine.slice(0, 160)}`);
          // Звонок завершаем через 8 c после ПОСЛЕДНЕЙ реплики (модель отвечает в два хода).
          if (globalThis.__endTimer) clearTimeout(globalThis.__endTimer);
          globalThis.__endTimer = setTimeout(() => {
            log(`итог: ready=${gotReady} аудио=${(gotAudio / 48000).toFixed(1)} c`);
            ws.send(JSON.stringify({ type: "end" }));
          }, 8000);
        }
      }
      break;
    case "action":
      log("ACTION", m.status, m.tool, m.summary.slice(0, 100));
      break;
    case "confirmation":
      log("CONFIRMATION", m.class, m.tool, "→ отмена кнопкой (негативный тест)");
      ws.send(JSON.stringify({ type: "confirm", confirmationId: m.confirmationId, decision: "cancel" }));
      break;
    case "confirmation_result":
      log("VERDICT:", m.verdict);
      break;
    case "warning":
      log("WARNING", m.code, m.message);
      break;
    case "error":
      log("ERROR", m.code, m.message);
      break;
    case "ended":
      log("ENDED", m.reason, `threadId=${m.threadId}`);
      log(`итог: ready=${gotReady} аудио=${(gotAudio / 48000).toFixed(1)} c`);
      log("ответ агента:", agentLine.slice(0, 300) || "(нет)");
      ws.close();
      process.exit(gotReady && gotAudio > 4800 ? 0 : 1);
      break;
    default:
      log("кадр:", m.type);
  }
};
ws.onclose = (e) => {
  log(`ws close ${e.code} ${e.reason || ""}`);
  if (!gotReady) process.exit(2);
};
ws.onerror = () => log("ws error");
setTimeout(() => { log("таймаут 90 c"); ws.close(); process.exit(3); }, 90_000);
