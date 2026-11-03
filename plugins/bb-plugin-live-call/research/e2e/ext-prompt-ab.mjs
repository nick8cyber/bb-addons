import { readFileSync } from "node:fs";
const k = process.env.K;
const data = readFileSync("./out/fake-overview.txt", "utf8");
const run = (sys) => new Promise((res) => { const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${k}`); let said = "", turns = [];
  const fin = () => { ws.close(); res(turns); };
  setTimeout(fin, 40000);
  ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live-extended-thinking", generationConfig: { responseModalities: ["AUDIO"], thinkingConfig: { thinkingLevel: "LOW" } }, outputAudioTranscription: {}, systemInstruction: { parts: [{ text: sys }] } } }));
  let step = 0;
  ws.onmessage = async (e) => { const m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString());
    if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text: "Привет! Расскажи подробно по каждому проекту в BB, что там происходит." } }));
    if (m.serverContent?.outputTranscription?.text) said += m.serverContent.outputTranscription.text;
    if (m.serverContent?.turnComplete) { turns.push(said.trim()); said = ""; if (step++ === 0) ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "[СИСТЕМА] инструмент bb_overview: " + data }] }], turnComplete: true } })); } };
});
for (const [name, f] of [["old", "./out/prompt-old.txt"], ["new", "./out/prompt-new.txt"]]) for (let i = 0; i < 6; i++) {
  const t = await run(readFileSync(f, "utf8"));
  console.log(name, i, "turns:", t.length, "| system error:", t.some((x) => /системн|system error/i.test(x)), "|", t.map((x) => x.slice(0, 50)).join(" || "));
}
process.exit(0);
