import { readFileSync } from "node:fs";
const keys = readFileSync(process.env.F, "utf8").split(/\s+/).filter(Boolean);
for (const [i, k] of keys.entries()) for (const model of ["gemini-3.8-live", "gemini-3.8-live-extended-thinking"]) {
  const r = await new Promise((res) => { const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${k}`);
    const t = setTimeout(() => { ws.close(); res("timeout"); }, 12000);
    ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/" + model, generationConfig: { responseModalities: ["AUDIO"], ...(model.includes("extended") ? { thinkingConfig: { thinkingLevel: "LOW" } } : {}) } } }));
    ws.onmessage = async (e) => { const m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString()); if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text: "Скажи да" } })); if (m.serverContent?.turnComplete) { clearTimeout(t); ws.close(); res("ok"); } };
    ws.onclose = (e) => { if (e.code !== 1000) { clearTimeout(t); res(`close ${e.code} ${String(e.reason).slice(0, 60)}`); } }; });
  console.log(`key${i + 1} ${model}: ${r}`);
}
process.exit(0);
