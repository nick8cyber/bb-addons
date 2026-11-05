// Official @google/genai SDK, docs-style extended thinking + NON_BLOCKING tool. One run per invocation.
const { GoogleGenAI, Modality, Behavior } = await import(process.env.SDK);
const ai = new GoogleGenAI({ apiKey: process.env.K });
const t0 = Date.now(); let got = null, apology = "", status = [];
const done = new Promise(res => setTimeout(res, +(process.env.T || 25000)));
let session;
session = await ai.live.connect({
  model: process.env.M || "gemini-3.8-live-extended-thinking",
  config: {
    responseModalities: [Modality.AUDIO],
    thinkingConfig: { thinkingLevel: process.env.TL || "high" },
    outputAudioTranscription: {},
    tools: [{ functionDeclarations: [{ name: "search_flights", description: "Search for flights to a destination city.", behavior: Behavior.NON_BLOCKING,
      parameters: { type: "OBJECT", properties: { destination: { type: "STRING", description: "Destination city" } }, required: ["destination"] } }] }],
  },
  callbacks: {
    onmessage: (m) => {
      if (m.toolCall && !got) { got = Date.now() - t0;
        session.sendToolResponse({ functionResponses: m.toolCall.functionCalls.map(fc => ({ id: fc.id, name: fc.name, response: { output: { flight: "DL 145", price: "$145" } } })) }); }
      if (m.serverContent?.outputTranscription?.text) apology += m.serverContent.outputTranscription.text;
      if (m.serverContent?.interactionStatus) status.push(m.serverContent.interactionStatus);
    },
    onerror: (e) => console.log("error", e.message),
    onclose: (e) => { if (e.code !== 1000) console.log("close", e.code, e.reason); },
  },
});
session.sendRealtimeInput({ text: "Find me flights to Seattle." });
await done; session.close();
const sysErr = /system error/i.test(apology);
console.log(JSON.stringify({ TL: process.env.TL || "high", toolCallMs: got, systemError: sysErr, status: status.join(">"), said: apology.slice(0, 90) }));
process.exit(0);
