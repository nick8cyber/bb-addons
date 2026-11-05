// ПОЛЬЗОВАТЕЛЬСКИЙ e2e live-call в настоящем Chromium (без фейкового бипа Chrome):
// 1) TTS-фраза из базовой модели -> WAV;
// 2) Chromium c перехватом getUserMedia: WAV проигрывается ОДИН раз в поток;
// 3) клик по кнопке 📞 как пользователь, ожидание, завершение звонка.
// Проверка — снаружи: bb call transcript <id> содержит owner_line с фразой и
// agent_line с ответом ОДНИМ сообщением.
// Запуск: K=<ключ AI Studio> node research/probes/browser-speech-e2e.mjs [фраза]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.K ?? "";
const PHRASE = process.argv[2] ?? "Сколько всего проектов в BB? Ответь одним числом.";
const APP = process.env.BB_APP ?? "http://127.0.0.1:38886";
const PORT = 9231;

if (!KEY) { console.error("нужен env K=<ключ Gemini для TTS>"); process.exit(1); }

const makeWav = () => new Promise((res, rej) => {
  const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`);
  const bufs = [];
  ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: "Произнеси текст пользователя вслух дословно." }] } } }));
  ws.onmessage = async (e) => {
    const raw = typeof e.data === "string" ? e.data : Buffer.from(new Uint8Array(await new Response(e.data).arrayBuffer())).toString();
    const m = JSON.parse(raw);
    if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text: PHRASE } }));
    for (const p of m.serverContent?.modelTurn?.parts || []) if (p.inlineData) bufs.push(Buffer.from(p.inlineData.data, "base64"));
    if (m.serverContent?.turnComplete || m.serverContent?.generationComplete) {
      const pcm = Buffer.concat(bufs);
      const hdr = Buffer.alloc(44);
      hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVE", 8);
      hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
      hdr.writeUInt32LE(24000, 24); hdr.writeUInt32LE(48000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
      hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
      res(Buffer.concat([hdr, pcm]));
    }
  };
  ws.onclose = () => rej(new Error("tts closed"));
  setTimeout(() => rej(new Error("tts timeout")), 20000);
});
const wav = await makeWav();
console.log("WAV фраза готова");

const inject = `
(function() {
  const wavB64 = ${JSON.stringify(wav.toString("base64"))};
  navigator.mediaDevices.getUserMedia = async () => {
    const bin = atob(wavB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource();
    src.buffer = buf; // без loop: фраза звучит один раз, иначе модель не может вставить слово
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    src.start();
    return dest.stream;
  };
})();`;

const profile = mkdtempSync(join(tmpdir(), "lc-e2e-"));
const chrome = spawn("snap", ["run", "chromium", "--headless=new", "--no-sandbox", "--disable-gpu",
  "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); target = list.find((t) => t.type === "page"); } catch {}
    if (!target) await sleep(1000);
  }
  if (!target) throw new Error("CDP target не найден");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
  await send("Page.navigate", { url: APP });
  let clicked = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    if (await evalJs(`!!document.getElementById("bb-live-call-button")`)) {
      await evalJs(`document.getElementById("bb-live-call-button").click()`);
      clicked = true; console.log(`клик 📞 на +${(i + 1) * 2}с`); break;
    }
  }
  if (!clicked) throw new Error("кнопка 📞 не появилась");
  for (let i = 0; i < 10; i++) await sleep(2500);
  await evalJs(`[...document.querySelectorAll("#bb-live-call-overlay button")].find(b => b.textContent.includes("Завершить"))?.click()`);
  console.log("звонок завершён. Проверь: bb call calls / bb call transcript <id>");
  console.log(`в транскрипте должно быть: owner_line с фразой и agent_line с ответом одним сообщением`);
  process.exitCode = 0;
} finally {
  chrome.kill();
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(process.exitCode ?? 0); }, 1000);
}
