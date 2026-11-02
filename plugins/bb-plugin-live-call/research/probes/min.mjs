const ver = process.env.V || "v1alpha", model = process.env.M;
const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${ver}.GenerativeService.BidiGenerateContent?key=${process.env.K}`);
const t0 = Date.now(); const log = (...a) => console.log(`@${Date.now()-t0}`, ...a);
setTimeout(() => { log("timeout"); process.exit(0); }, +(process.env.T || 45000));
ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/" + model,
  generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } }, ...(process.env.TL ? { thinkingConfig: { thinkingLevel: process.env.TL } } : {}) },
  ...(process.env.TR ? { outputAudioTranscription: {} } : {}),
  tools: [{ functionDeclarations: [{ name: "searchFlights", description: "Search flights", behavior: "NON_BLOCKING", parameters: { type: "OBJECT", properties: { destination: { type: "STRING" } }, required: ["destination"] } }] }] } }));
ws.onmessage = async (e) => { const txt = typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString(); const m = JSON.parse(txt);
  if (m.setupComplete) { log("setupComplete"); ws.send(JSON.stringify({ realtimeInput: { text: process.env.Q || "Find flights to Seattle" } })); return; }
  if (m.toolCall) { log("TOOLCALL", JSON.stringify(m.toolCall), m.interactionStatus || "");
    for (const fc of m.toolCall.functionCalls) ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { output: { flight: "DL 145", price: "$145" } } }] } })); return; }
  const sc = m.serverContent; if (!sc) { if (txt.trim() !== "{}" && !m.sessionResumptionUpdate) log("other", txt.replace(/\s+/g," ").slice(0,200)); return; }
  if (sc.outputTranscription) log("out:", sc.outputTranscription.text);
  if (sc.turnComplete) log("turnComplete", sc.interactionStatus || "");
};
ws.onclose = (e) => { log("close", e.code, e.reason); process.exit(0); };
