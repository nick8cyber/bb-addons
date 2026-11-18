// Google sign-in state machine for the Gemini web profile.
// usage: node scripts/glogin.mjs <email> <secrets-env-file>
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const driver = require(new URL('../src/gemini-driver.js', import.meta.url).pathname);

const [EMAIL, ENVFILE] = process.argv.slice(2);
const vars = {};
for (const l of fs.readFileSync(ENVFILE, 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) vars[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const PASS = vars.GOOGLE_PASSWORD;

const probe = (page) => page.evaluate(() => {
  const vis = el => !!(el && el.offsetParent !== null);
  const q = s => { const e = document.querySelector(s); return e && vis(e) ? e : null; };
  const btns = [...document.querySelectorAll('button,div[role="button"],span[role="button"],li,a')].filter(vis)
    .map(e => e.innerText.trim()).filter(t => t && t.length < 60);
  return {
    url: location.href.slice(0, 100),
    emailInp: !!q('input#identifierId,input[type="email"]'),
    passInp: !!q('input[type="password"]'),
    birthday: /дату рождения|date of birth/i.test(document.body ? document.body.innerText : ''),
    thanks: /^спасибо|thank/i.test(document.body ? document.body.innerText.trim() : ''),
    textbox: !!q('[contenteditable="true"],rich-textarea'),
    accLabel: (document.querySelector('[aria-label*="account" i],[aria-label*="аккаунт" i]') || {}).getAttribute?.('aria-label') || '',
    btns: btns.slice(0, 12),
    head: (document.body ? document.body.innerText : '').slice(0, 140)
  };
}).catch(e => ({ evalErr: e.message.split('\n')[0] }));

const clickBtn = async (page, re) => {
  const el = page.locator(`button:has-text("${re.source}"), div[role="button"]:has-text("${re.source}"), span[role="button"]:has-text("${re.source}")`).first();
  try { await el.click({ timeout: 3000 }); return true; } catch {}
  // li options are not trusted-clickable via locator text on google — use coords
  const c = await page.evaluate((reSrc) => {
    const vis = el => !!(el && el.offsetParent !== null);
    const rx = new RegExp(reSrc, 'i');
    const e = [...document.querySelectorAll('li,button,div[role="button"],span[role="button"],a')].filter(vis)
      .find(e => rx.test(e.innerText) && e.innerText.length < 80);
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, re.source);
  if (c) { await page.mouse.click(c.x, c.y); return true; }
  return false;
};

(async () => {
  const pwl = driver.getPlaywright();
  const browser = await pwl.chromium.connectOverCDP(`http://localhost:${process.env.GEMINI_CDP_PORT || '9222'}`);
  try {
    let page = null;
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().includes('google')) page = p;
    if (!page) page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
    if (!/accounts\.google\.com|gemini/.test(page.url()))
      await page.goto('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp', { waitUntil: 'domcontentloaded' });
    if (/gemini\.google\.com/.test(page.url()))
      await page.goto('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp', { waitUntil: 'domcontentloaded' });

    let emailDone = false, passDone = false;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(2000);
      const s = await probe(page);
      console.log(`S${i}`, JSON.stringify(s));
      if (s.textbox && /gemini\.google\.com\/app/.test(s.url)) { console.log('STATE: APP'); break; }
      if (/sorry|rejected/.test(s.url)) { console.log('STATE: BLOCKED'); break; }
      if (!emailDone && s.emailInp) {
        await page.click('input#identifierId, input[type="email"]');
        await page.keyboard.type(EMAIL, { delay: 40 });
        await page.keyboard.press('Enter');
        emailDone = true; continue;
      }
      if (emailDone && !passDone) {
        if (s.passInp) {
          await page.click('input[type="password"]');
          await page.keyboard.type(PASS, { delay: 40 });
          await page.keyboard.press('Enter');
          passDone = true; continue;
        }
        if (s.btns.some(b => /try another way|другой способ/i.test(b))) {
          await clickBtn(page, /try another way|другой способ/i); continue;
        }
        if (s.btns.some(b => /enter your password|введите пароль/i.test(b))) {
          await clickBtn(page, /enter your password|введите пароль/i); continue;
        }
      }
      if (s.birthday) {
        const day = await page.$('#i3'); if (day) { await day.click(); await page.keyboard.press('Control+a'); await page.keyboard.type('15', { delay: 60 }); }
        const combo = await page.evaluate(() => { const e = [...document.querySelectorAll('[role="combobox"]')].filter(el => el.offsetParent !== null)[0]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        if (combo) { await page.mouse.click(combo.x, combo.y); await page.waitForTimeout(800); }
        const li = await page.evaluate(() => { const vis = el => !!(el && el.offsetParent !== null); const e = [...document.querySelectorAll('[role="option"],ul li')].filter(vis).find(e => /^(январь|january)$/i.test(e.innerText.trim())); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        if (li) { await page.mouse.click(li.x, li.y); await page.waitForTimeout(500); }
        const yr = await page.$('#i8'); if (yr) { await yr.click(); await page.keyboard.press('Control+a'); await page.keyboard.type('1990', { delay: 60 }); }
        await clickBtn(page, /сохранить|save/i); continue;
      }
      if (s.btns.some(b => /подтвердить|confirm/i.test(b))) { await clickBtn(page, /подтвердить|confirm/i); continue; }
      if (s.thanks || s.btns.some(b => /готово|done|далее|next/i.test(b))) { await clickBtn(page, /готово|done|далее|next|продолжить|continue/i); continue; }
    }
    const fin = await probe(page);
    console.log('FINAL', JSON.stringify(fin));
    if (process.env.GLOGIN_SCREENSHOT) {
      const shotPath = process.env.GLOGIN_SCREENSHOT === '1' ? '/tmp/glogin-end.jpg' : process.env.GLOGIN_SCREENSHOT;
      await page.screenshot({ path: shotPath, type: 'jpeg', quality: 60 });
    }
  } finally { await browser.close(); }
})().catch(e => console.log('FATAL', e.message.split('\n')[0]));
