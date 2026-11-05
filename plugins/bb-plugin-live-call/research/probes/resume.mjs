// phase 1 with key A: tell a secret word, capture handle; phase 2 with key B (or A): resume and ask.
const url = k => `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${k}`;
function run(key, handle, text) { return new Promise(res => {
  const ws = new WebSocket(url(key)); let last = handle, out = "", t = setTimeout(() => { ws.close(); res({ last, out, err: "timeout" }); }, 20000);
  ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] }, outputAudioTranscription: {}, sessionResumption: handle ? { handle } : {} } }));
  ws.onmessage = async e => { const m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString());
    if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text } }));
    if (m.sessionResumptionUpdate?.newHandle) last = m.sessionResumptionUpdate.newHandle;
    if (m.serverContent?.outputTranscription) out += m.serverContent.outputTranscription.text;
    if (m.serverContent?.turnComplete) { setTimeout(() => { clearTimeout(t); ws.close(); res({ last, out }); }, 1500); } };
  ws.onclose = e => { clearTimeout(t); res({ last, out, code: e.code, reason: e.reason }); };
}); }
const a = await run(process.env.KA, null, "Remember: the secret word is PELICAN. Just say OK.");
console.log("A:", a.out, a.code ?? "", a.reason ?? "");
const same = await run(process.env.KA, a.last, "What is the secret word?");
console.log("resume same key:", same.out, same.code ?? "", same.reason ?? "");
const b = await run(process.env.KB, same.last, "What is the secret word? Say it again.");
console.log("resume OTHER key:", b.out, b.code ?? "", b.reason ?? "");
process.exit(0);
