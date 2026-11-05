// 1) base gemini-3.8-live speaks a phrase -> capture 24k PCM; 2) resample to 16k; 3) stream as mic audio into extended with a NON_BLOCKING tool.
const W = k => `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${k}`;
const parse = async e => JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString());
const phrase = process.env.P || "Find me flights to Seattle, please.";
const tts = () => new Promise(res => { const ws = new WebSocket(W(process.env.KA)); const bufs = [];
  ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: "Repeat the user's text out loud exactly, word for word, nothing else." }] } } }));
  ws.onmessage = async e => { const m = await parse(e); if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text: phrase } }));
    for (const p of m.serverContent?.modelTurn?.parts || []) if (p.inlineData) bufs.push(Buffer.from(p.inlineData.data, "base64"));
    if (m.serverContent?.turnComplete) { ws.close(); res(Buffer.concat(bufs)); } }; });
const pcm24 = await tts();
const s24 = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2), n16 = Math.floor(s24.length * 2 / 3), s16 = new Int16Array(n16);
for (let i = 0; i < n16; i++) { const x = i * 1.5, j = Math.floor(x), f = x - j; s16[i] = (s24[j] * (1 - f) + (s24[j + 1] ?? s24[j]) * f) | 0; }
console.log(`speech: ${(s16.length / 16000).toFixed(2)}s`);
const t0 = Date.now(); const log = (...a) => console.log(`@${Date.now() - t0}`.padEnd(7), ...a);
const ws = new WebSocket(W(process.env.KB)); let out = "", inT = "";
ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/" + (process.env.M || "gemini-3.8-live-extended-thinking"),
  generationConfig: { responseModalities: ["AUDIO"], ...(process.env.M ? {} : { thinkingConfig: { thinkingLevel: process.env.TL || "LOW" } }) },
  inputAudioTranscription: {}, outputAudioTranscription: {},
  tools: [{ functionDeclarations: [{ name: "searchFlights", description: "Search for flights to a destination", behavior: "NON_BLOCKING",
    parameters: { type: "OBJECT", properties: { destination: { type: "STRING" } }, required: ["destination"] } }] }] } }));
ws.onmessage = async e => { const m = await parse(e);
  if (m.setupComplete) { log("setupComplete; streaming mic audio"); const frame = 320; let i = 0;
    const silence = new Int16Array(16000); const all = new Int16Array(s16.length + silence.length); all.set(s16); // speech + 1s silence for VAD
    const tick = setInterval(() => { if (i >= all.length) { clearInterval(tick); log("audio sent"); return; }
      const chunk = all.subarray(i, i + frame); i += frame;
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64"), mimeType: "audio/pcm;rate=16000" } } })); }, 20);
    return; }
  if (m.toolCall) { log("TOOLCALL", JSON.stringify(m.toolCall.functionCalls));
    ws.send(JSON.stringify({ toolResponse: { functionResponses: m.toolCall.functionCalls.map(f => ({ id: f.id, name: f.name, response: { output: { flight: "DL 145", price: "$145" } } })) } })); }
  const sc = m.serverContent; if (!sc) return;
  if (sc.inputTranscription?.text) inT += sc.inputTranscription.text;
  if (sc.outputTranscription?.text) out += sc.outputTranscription.text;
  if (sc.turnComplete) { log(`turn (${sc.interactionStatus || "-"}) heard="${inT.trim()}" said="${out.trim().slice(0, 120)}"`); out = ""; } };
ws.onclose = e => { if (e.code !== 1000) log("close", e.code, e.reason); };
setTimeout(() => { ws.close(); process.exit(0); }, +(process.env.T || 35000));
