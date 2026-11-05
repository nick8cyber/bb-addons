const k = process.env.K;
const run = (model, voice) => new Promise((res) => { const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${k}`); const bufs = [];
  ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/" + model, generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }, languageCode: "ru-RU" }, ...(model.includes("extended") ? { thinkingConfig: { thinkingLevel: "LOW" } } : {}) }, systemInstruction: { parts: [{ text: "Прочитай текст пользователя вслух дословно." }] } } }));
  ws.onmessage = async (e) => { const m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString()); if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text: "Привет! Всё отлично, готов помочь. Что посмотрим в первую очередь?" } }));
    for (const p of m.serverContent?.modelTurn?.parts || []) if (p.inlineData) bufs.push(Buffer.from(p.inlineData.data, "base64"));
    if (m.serverContent?.turnComplete) { ws.close(); res(Buffer.concat(bufs)); } }; setTimeout(() => res(Buffer.concat(bufs)), 25000); });
// median F0 via autocorrelation on voiced frames
const f0 = (buf) => { const s = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1); const sr = 24000, N = 1024, out = [];
  for (let off = 0; off + N < s.length; off += N) { let e = 0; for (let i = 0; i < N; i++) e += s[off + i] ** 2; if (e / N < 1e6) continue;
    let best = 0, bl = 0; for (let lag = 60; lag <= 400; lag++) { let c = 0; for (let i = 0; i < N - lag; i++) c += s[off + i] * s[off + i + lag]; if (c > best) { best = c; bl = lag; } } if (bl) out.push(sr / bl); }
  out.sort((a, b) => a - b); return out.length ? Math.round(out[out.length >> 1]) : null; };
for (const [m, v] of [["gemini-3.8-live", "Algenib"], ["gemini-3.8-live-extended-thinking", "Algenib"], ["gemini-3.8-live", "Puck"], ["gemini-3.8-live-extended-thinking", "Puck"]]) { const b = await run(m, v); console.log(m.padEnd(36), v.padEnd(8), "sec", (b.length / 48000).toFixed(1), "F0", f0(b)); }
process.exit(0);
