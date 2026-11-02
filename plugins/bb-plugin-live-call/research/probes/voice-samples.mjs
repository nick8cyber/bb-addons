// Generate a Russian sample per prebuilt voice via gemini-3.8-live; writes raw PCM 24k to OUT/<voice>.pcm
import { writeFileSync } from "node:fs";
const OUT = process.env.OUT, keys = process.env.KEYS.split(" "), voices = process.env.VOICES.split(" ");
const text = "Привет! Я голосовой координатор BB. бот-A закончил: сто сорок два теста из ста сорока двух зелёные. Запускать push или сначала ревью?";
const W = k => `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${k}`;
const one = (voice, key) => new Promise(res => { const ws = new WebSocket(W(key)); const bufs = []; let said = "";
  const to = setTimeout(() => { ws.close(); res({ voice, ok: false, err: "timeout" }); }, 30000);
  ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live",
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }, languageCode: "ru-RU" } },
    outputAudioTranscription: {},
    systemInstruction: { parts: [{ text: "Ты диктор. Прочитай текст пользователя вслух по-русски дословно, естественно и живо, ничего не добавляя и не отвечая на него." }] } } }));
  ws.onmessage = async e => { const m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString());
    if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text } }));
    for (const p of m.serverContent?.modelTurn?.parts || []) if (p.inlineData) bufs.push(Buffer.from(p.inlineData.data, "base64"));
    if (m.serverContent?.outputTranscription?.text) said += m.serverContent.outputTranscription.text;
    if (m.serverContent?.turnComplete) { clearTimeout(to); ws.close(); const b = Buffer.concat(bufs); writeFileSync(`${OUT}/${voice}.pcm`, b); res({ voice, ok: true, sec: +(b.length / 48000).toFixed(1), said: said.trim() }); } };
  ws.onclose = e => { if (e.code !== 1000) { clearTimeout(to); res({ voice, ok: false, err: `${e.code} ${e.reason}` }); } }; });
const results = []; const batch = 6;
for (let i = 0; i < voices.length; i += batch) results.push(...await Promise.all(voices.slice(i, i + batch).map((v, j) => one(v, keys[(i + j) % keys.length]))));
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
for (const r of results) console.log(r.voice.padEnd(14), r.ok ? `${r.sec}s` : `FAIL ${r.err}`, r.ok ? r.said.slice(0, 70) : "");
process.exit(0);
