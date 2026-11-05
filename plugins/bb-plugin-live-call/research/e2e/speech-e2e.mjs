import { chromium } from "/usr/lib/node_modules/playwright/index.mjs";
const KEY = process.env.K, PHRASE = process.env.P;
const pcm = await new Promise((res, rej) => {
  const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`); const bufs = [];
  ws.onopen = () => ws.send(JSON.stringify({ setup: { model: "models/gemini-3.8-live", generationConfig: { responseModalities: ["AUDIO"] }, systemInstruction: { parts: [{ text: "Произнеси текст пользователя вслух дословно, ничего не добавляя." }] } } }));
  ws.onmessage = async (e) => { const m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(await e.data.arrayBuffer()).toString());
    if (m.setupComplete) ws.send(JSON.stringify({ realtimeInput: { text: PHRASE } }));
    for (const p of m.serverContent?.modelTurn?.parts || []) if (p.inlineData) bufs.push(Buffer.from(p.inlineData.data, "base64"));
    if (m.serverContent?.turnComplete) { ws.close(); res(Buffer.concat(bufs)); } };
  ws.onerror = () => rej(new Error("tts")); });
const b64 = pcm.toString("base64");
const browser = await chromium.launch({ executablePath: process.env.EXE, args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1440), height: +(process.env.H || 900) }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/CORS|ERR_FAILED|38888/.test(m.text())) errors.push(m.text().slice(0, 200)); });
await page.addInitScript((b64) => {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const s = new Int16Array(raw.buffer);
    const buf = ctx.createBuffer(1, s.length + 48000, 24000); const d = buf.getChannelData(0); for (let i = 0; i < s.length; i++) d[i] = s[i] / 32768;
    const src = ctx.createBufferSource(); src.buffer = buf; const dest = ctx.createMediaStreamDestination(); src.connect(dest);
    setTimeout(() => src.start(), 2500); return dest.stream; };
}, b64);
await page.goto(process.env.URL || "http://127.0.0.1:38886/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("button[aria-label=\"Позвонить координатору\"]", { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1500);
const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((e) => (e.getAttribute("aria-label") || e.title || "").includes("Позвонить координатору")); b?.click(); return !!b; });
console.log("clicked", clicked);
await page.waitForTimeout(+(process.env.TALK || 26000));
await page.screenshot({ path: "./out/e2e-live.png" });
const feed = await page.evaluate(() => [...document.querySelectorAll(".lc-feed > *")].map((e) => e.className.split(" ")[0] + ": " + e.textContent.slice(0, 120)));
console.log("feed:\n" + feed.join("\n"));
const link = await page.$(".lc-card .lc-link");
if (link) { await link.click(); await page.waitForTimeout(2500); console.log("after open url:", page.url()); }
await page.evaluate(() => [...document.querySelectorAll("button")].find((e) => e.getAttribute("aria-label") === "Завершить звонок")?.click());
await page.waitForTimeout(4000);
await page.screenshot({ path: "./out/e2e-summary.png" });
console.log("summary:", await page.evaluate(() => document.querySelector(".lc-dock, .lc-mobile")?.textContent?.slice(0, 300)));
console.log("errors:", errors.length ? errors.join("\n") : "none");
await browser.close();
