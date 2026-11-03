import { chromium } from "/usr/lib/node_modules/playwright/index.mjs";
const url = process.env.URL || "http://127.0.0.1:38886/";
const out = process.env.OUT || "./out/bb.png";
const browser = await chromium.launch({ executablePath: process.env.EXE, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1440), height: +(process.env.H || 900) }, colorScheme: process.env.SCHEME || "dark" });
page.on("console", m => { if (m.type() === "error") console.log("console.error:", m.text().slice(0, 200)); });
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(e => console.log("goto:", e.message));
await page.waitForTimeout(+(process.env.WAIT || 4000));
if (process.env.EVAL) { const r = await page.evaluate(process.env.EVAL).catch(e => "eval error: " + e.message); console.log("eval:", JSON.stringify(r).slice(0, 500)); await page.waitForTimeout(+(process.env.WAIT2 || 1500)); }
await page.screenshot({ path: out, fullPage: false });
console.log("saved", out, await page.title());
await browser.close();
