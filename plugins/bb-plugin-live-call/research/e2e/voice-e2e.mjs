/**
 * Приёмка звонка живым (синтезированным) голосом в настоящем Chromium — без ключа Gemini.
 *
 * FIX=<папка с фикстурами *.pcm 24 кГц> SCENARIO=<general|barge|early|echo|fail|button-early> [THREAD_ID=thr_…]
 * [ECHO=0.6] [OUT=./out] node research/e2e/voice-e2e.mjs
 *
 * - Фразы владельца — готовые PCM-фикстуры (синтезирует куратор), подаются в подменённый микрофон
 *   ПО СОБЫТИЯМ журнала звонка (confirm, question_heard, confirm_phase), а не по таймеру.
 * - ECHO > 0: всё, что страница играет в динамик, подмешивается в микрофон с этим усилением —
 *   настоящее эхо для проверки, что голос сам себя не подтверждает.
 * - PASS/FAIL считается из журнала ~/.bb/plugins/live-call/data.db, без захардкоженных true.
 * Перед запуском: bb call status | grep -q "звонок: нет". Кнопки реестра скрипт не нажимает.
 */
import { chromium } from "/usr/lib/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCENARIO = process.env.SCENARIO || "general";
const FIX = process.env.FIX;
const THREAD_ID = process.env.THREAD_ID || "";
const ECHO = +(process.env.ECHO || (SCENARIO === "echo" ? 0.6 : 0));
const OUT = process.env.OUT || "./out";
const APP = process.env.BB_APP || "http://127.0.0.1:38886";
const DB = join(homedir(), ".bb/plugins/live-call/data.db");
if (!FIX || !existsSync(FIX)) throw new Error("FIX=<папка фикстур> обязательна");
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
const sql = (q) => sh("sqlite3", ["-json", DB, q]).trim();
const rows = (q) => { const r = sql(q); return r ? JSON.parse(r) : []; };
const fixture = (name) => readFileSync(join(FIX, `${name}.pcm`)).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!sh("bb", ["call", "status"]).includes("звонок: нет")) { console.error("идёт звонок — не запускаю"); process.exit(3); }

const browser = await chromium.launch({
  executablePath: process.env.EXE,
  args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: +(process.env.W || 1440), height: +(process.env.H || 900) }, colorScheme: "dark" });
page.on("pageerror", (e) => log("pageerror", e.message.slice(0, 200)));

// Подменённый микрофон: динамическая подача фраз + петля «динамик → микрофон» (эхо).
await page.addInitScript((echoGainValue) => {
  let micCtx = null, micDest = null, echoGain = null;
  const taps = [];
  const origConnect = AudioNode.prototype.connect;
  // Счётчик реально проигранного звука страницы (независимо от оценки сервера): каждые 20 мс
  // уровень сигнала; window.__lcPlayed(from, to) — мс звука между отметками Date.now().
  let meter = null;
  const played = [];
  window.__lcPlayed = (from, to) => played.filter((t) => t >= from && t <= to).length * 20;
  const attach = () => {
    if (!micCtx) return;
    if (!meter) {
      meter = micCtx.createAnalyser(); meter.fftSize = 512;
      const buf = new Float32Array(meter.fftSize);
      setInterval(() => {
        meter.getFloatTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += v * v;
        // Порог низкий, чтобы паузы внутри речи меньше занижали счёт. Считаем именно кадры со
        // звуком, а не время от первого звука: иначе пауза генерации между филлером и вопросом
        // засчиталась бы как «вопрос звучал» (ложный PASS). Ошибка — в сторону ложного FAIL.
        if (Math.sqrt(sum / buf.length) > 0.003) played.push(Date.now());
      }, 20);
    }
    while (taps.length) {
      const src = micCtx.createMediaStreamSource(taps.shift());
      origConnect.call(src, echoGain);
      origConnect.call(src, meter);
    }
  };
  AudioNode.prototype.connect = function (target, ...rest) {
    const r = origConnect.call(this, target, ...rest);
    try {
      if (target instanceof AudioDestinationNode && this.context !== micCtx) {
        const ctx = this.context;
        if (!ctx.__lcTap) { ctx.__lcTap = ctx.createMediaStreamDestination(); taps.push(ctx.__lcTap.stream); attach(); }
        origConnect.call(this, ctx.__lcTap);
      }
    } catch { /* звук страницы без петли — эхо просто не подмешается */ }
    return r;
  };
  navigator.mediaDevices.getUserMedia = async () => {
    micCtx = new AudioContext({ sampleRate: 48000 });
    micDest = micCtx.createMediaStreamDestination();
    echoGain = micCtx.createGain();
    echoGain.gain.value = echoGainValue;
    origConnect.call(echoGain, micDest);
    const keep = micCtx.createConstantSource(); keep.offset.value = 0; origConnect.call(keep, micDest); keep.start();
    attach();
    window.__lcSay = (b64) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const s = new Int16Array(raw.buffer, 0, raw.length >> 1);
      const buf = micCtx.createBuffer(1, s.length, 24000);
      const d = buf.getChannelData(0);
      for (let i = 0; i < s.length; i++) d[i] = s[i] / 32768;
      const src = micCtx.createBufferSource(); src.buffer = buf; origConnect.call(src, micDest); src.start();
      return s.length / 24;
    };
    return micDest.stream;
  };
}, ECHO);

const say = async (name) => {
  const at = Date.now();
  const ms = await page.evaluate((b64) => window.__lcSay?.(b64) ?? -1, fixture(name));
  log(`>> владелец (${name}), ${(ms / 1000).toFixed(1)} с`);
  return { at, end: at + ms };
};
const clickButton = async (match) => {
  for (let i = 0; i < 40; i++) {
    const ok = await page.evaluate((m) => {
      const b = [...document.querySelectorAll("button, [role=button]")].find((e) => ((e.getAttribute("aria-label") || "") + " " + (e.title || "") + " " + (e.textContent || "")).includes(m));
      if (b) { b.click(); return true; }
      return false;
    }, match);
    if (ok) return true;
    await sleep(500);
  }
  return false;
};
let callId = null;
const events = (kind) => rows(`select seq, ts, kind, payload from call_events where call_id='${callId}'${kind ? ` and kind='${kind}'` : ""} order by seq`).map((e) => ({ ...e, p: JSON.parse(e.payload || "{}") }));
const waitEvent = async (kind, after = 0, timeoutMs = 60000, pred = () => true) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = events(kind).find((e) => e.ts >= after && pred(e));
    if (hit) return hit;
    await sleep(250);
  }
  return null;
};
/** Последний seq треда до звонка: сообщения после него — только этого звонка (JSON — старейшие первыми). */
const threadEvents = (args) => { const d = JSON.parse(sh("bb", ["thread", "messages", THREAD_ID, "--json", ...args])); return Array.isArray(d) ? d : (d.events ?? []); };
const lastSeq = () => { let seq = 0; for (const e of threadEvents(["--all"])) seq = Math.max(seq, Number(e.seq ?? 0)); return seq; };
const startSeq = THREAD_ID ? lastSeq() : 0;
/** Тексты сообщений «[голос] …» в тест-треде после начала звонка. */
const threadVoiceSince = () =>
  threadEvents(["--after-seq", String(startSeq), "--limit", "200"])
    .flatMap((e) => (e.data?.input ?? []).map((x) => String(x?.text ?? "")))
    .filter((t) => t.startsWith("[голос]"));
const result = { scenario: SCENARIO, checks: [] };
const check = (name, ok, detail = "") => { result.checks.push({ name, ok: Boolean(ok), detail }); log(ok ? "PASS" : "FAIL", name, detail); };

// Вход в звонок
const startedAfter = Date.now();
if (THREAD_ID) {
  await page.goto(`${APP}/threads/${THREAD_ID}`, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  check("кнопка «Позвонить по треду» найдена", await clickButton("Позвонить по треду"));
} else {
  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  check("кнопка «Позвонить координатору» найдена", await clickButton("Позвонить координатору"));
}
for (let i = 0; i < 40 && !callId; i++) {
  const r = rows(`select id from calls where started_at >= ${startedAfter - 1000} order by started_at desc limit 1`);
  if (r[0]) callId = r[0].id; else await sleep(250);
}
check("звонок начался", callId, callId ?? "");
if (!callId) { await browser.close(); process.exit(1); }
log("callId", callId);
await waitEvent("agent_line", 0, 20000); // приветствие
await sleep(1500);

if (SCENARIO === "general") {
  const s = await say("q_projects");
  const owner = await waitEvent("owner_line", s.at, 20000);
  check("реплика владельца распознана", owner, owner?.p.text ?? "");
  const answer = await waitEvent("agent_line", (owner?.ts ?? s.at) + 1, 40000, (e) => !/секунд/i.test(e.p.text));
  const toolUsed = events("action").find((e) => e.ts >= (owner?.ts ?? s.at) && e.ts <= (answer?.ts ?? Infinity) && e.p.status === "done");
  check("голос ответил по данным инструмента", answer && toolUsed, `${toolUsed?.p.tool ?? "без инструмента"}: ${answer?.p.text?.slice(0, 120) ?? ""}`);
  check("без «системной ошибки»", !events("agent_line").some((e) => /системн\S* ошибк/i.test(e.p.text)));
} else if (SCENARIO === "barge" || SCENARIO === "early" || SCENARIO === "fail") {
  const phrase = SCENARIO === "fail" ? "brain_fail" : "send_ok";
  const s = await say(phrase);
  const confirm = await waitEvent("confirm", s.at, 30000);
  check("запрошено подтверждение", confirm, confirm?.p.tool ?? "");
  if (SCENARIO === "early" && confirm) {
    // «да» во время филлера: 1,7 с после запроса — раньше, чем вопрос зазвучит
    await sleep(Math.max(0, confirm.ts + 1700 - Date.now()));
    const heardBefore = events("question_heard")[0];
    const early = await say("da");
    await sleep(2500);
    const v1 = events("verdict").find((e) => e.ts >= early.at);
    void heardBefore;
    const heardEv = await waitEvent("question_heard", confirm.ts, 20000);
    const offsetMs = heardEv?.p.offsetMs ?? 0;
    const playedAtDa = await page.evaluate(([a, b]) => window.__lcPlayed(a, b), [confirm.ts, early.end]);
    check("«да» подано до вопроса (по звуку браузера)", playedAtDa <= offsetMs, `проиграно ${playedAtDa} мс, до вопроса ${offsetMs} мс`);
    check("«да» до вопроса не засчитано", !v1, v1 ? `verdict ${v1.p.verdict} в ${v1.ts}` : "вердикта нет");
  }
  const heard = await waitEvent("question_heard", confirm?.ts ?? 0, 20000);
  check("вопрос зазвучал (question_heard)", heard);
  let verdict = events("verdict").find((e) => e.ts >= (confirm?.ts ?? 0));
  if (SCENARIO !== "early") check("до «да» вердикта нет", !verdict, verdict ? `${verdict.p.verdict} в ${verdict.ts}` : "");
  if (!verdict && heard) {
    if (SCENARIO === "barge") await sleep(Math.max(0, heard.p.at + 800 - Date.now()));
    else await waitEvent("confirm_phase", confirm.ts, 30000, (e) => e.p.phase === "listening");
    const da = await say("da");
    verdict = await waitEvent("verdict", da.at, 15000);
    const listening = events("confirm_phase").find((e) => e.p.phase === "listening" && e.ts >= confirm.ts);
    check("«да» засчитано", verdict?.p.verdict === "approved", verdict?.p.verdict ?? "нет вердикта");
    if (SCENARIO === "barge") {
      // Независимо от оценки шлюза: к моменту вердикта браузер реально проиграл ≥ offsetMs звука
      // после запроса — то есть вопрос уже звучал (offsetMs — звук до вопроса, по байтам сервера).
      const playedMs = verdict ? await page.evaluate(([a, b]) => window.__lcPlayed(a, b), [confirm.ts, verdict.ts]) : 0;
      check("вопрос реально звучал в браузере к моменту «да»", verdict && playedMs > (heard.p.offsetMs ?? 0), `проиграно ${playedMs} мс, до вопроса ${heard.p.offsetMs} мс`);
      check("засчитано ДО конца вопроса (перебивание, окно ещё не открыто)", verdict && (!listening || verdict.ts < listening.ts), `verdict ${verdict?.ts}, окно ${listening?.ts ?? "не открылось"}`);
    }
  }
  const action = await waitEvent("action", verdict?.ts ?? 0, 30000, (e) => e.p.status === "done" || e.p.status === "failed");
  if (SCENARIO === "fail") {
    check("действие не выполнено (ожидаемо)", action?.p.status === "failed", action?.p.summary ?? "");
    const after = await waitEvent("agent_line", (action?.ts ?? 0) + 1, 20000, (e) => !/^секунд/i.test(e.p.text.trim()));
    check("голос честно сказал о неудаче", after && /не удал|не получ|не смог|невозможн|нет отдельной|недоступ/i.test(after.p.text) && !/готово|создал|выполнен[оа]? успешно/i.test(after.p.text), after?.p.text ?? "");
  } else {
    check("действие выполнено", action?.p.status === "done", action?.p.summary ?? "");
    check("без «не доставлено»", !events("tool_error").some((e) => /delivery_failed|не доставлено/.test(e.payload)));
    if (THREAD_ID) check("сообщение [голос] в треде (этого звонка)", threadVoiceSince().some((t) => /перебиван/i.test(t)));
  }
} else if (SCENARIO === "button-early") {
  // Кнопка «Подтвердить» на карточке раньше вопроса: голос не должен дочитывать решённый вопрос.
  // В проекте без git действие падает быстро — медленное действие покрыто юнит-тестом
  // (quiet-inject: «кнопка «Подтвердить» при медленном действии»).
  const s = await say("brain_fail");
  const confirm = await waitEvent("confirm", s.at, 30000);
  check("запрошено подтверждение", confirm);
  await sleep(1500);
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((e) => /Подтвердить|Выполнить|Да\b/.test(e.textContent || "") && e.closest("[class*=confirm]"));
    if (b) { b.click(); return true; }
    return false;
  });
  const clickedAt = Date.now();
  check("кнопка подтверждения на карточке нажата", clicked);
  const verdict = await waitEvent("verdict", confirm?.ts ?? 0, 10000);
  check("вердикт кнопкой", verdict?.p.verdict === "approved", verdict?.p.verdict ?? "нет");
  const heardB = events("question_heard").find((e) => e.ts >= (confirm?.ts ?? 0));
  check("кнопка нажата раньше, чем вопрос зазвучал", !heardB || clickedAt < heardB.p.at, heardB ? `клик ${clickedAt}, вопрос ${heardB.p.at}` : "вопрос не начался — оборван");
  await sleep(20000);
  const reread = events("agent_line").filter((e) => e.ts > (verdict?.ts ?? 0) && /\?\s*$/.test(e.p.text) && /мозгов|задач/i.test(e.p.text));
  check("решённый вопрос не перечитан", reread.length === 0, reread.map((e) => e.p.text).join(" | ").slice(0, 200));
} else if (SCENARIO === "echo") {
  const s = await say("send_echo");
  const confirm = await waitEvent("confirm", s.at, 30000);
  check("запрошено подтверждение", confirm);
  const heard = await waitEvent("question_heard", confirm?.ts ?? 0, 20000);
  check("вопрос реально звучал (эхо — эхо вопроса)", heard);
  log("молчу 40 с — в микрофоне только эхо динамика");
  await sleep(40000);
  const v = events("verdict").find((e) => e.ts >= (confirm?.ts ?? 0) && e.p.verdict === "approved");
  check("эхо не подтвердило действие", !v, v ? `approved в ${v.ts}` : "");
  // сводка mic — за 5 с; первые 5 с после конца фразы владельца ещё содержат её хвост
  const mics = events("mic").filter((e) => e.ts >= s.end + 5000).map((e) => +((/пик (\d+)/.exec(e.p.message) || [])[1] || 0));
  check("эхо реально было в микрофоне (пик > 500 после фразы)", mics.some((x) => x > 500), `пики: ${mics.slice(0, 8).join(", ")}`);
  if (THREAD_ID) check("сообщение в тред не ушло (за этот звонок)", !threadVoiceSince().some((t) => /эха/i.test(t)));
  const listening = await waitEvent("confirm_phase", confirm?.ts ?? 0, 5000, (e) => e.p.phase === "listening");
  check("окно ответа открылось", listening);
  const o = await say("otmena");
  const vc = await waitEvent("verdict", o.at, 10000);
  check("«Отмена» голосом после вопроса — cancelled", vc?.p.verdict === "cancelled", vc?.p.verdict ?? "нет");
}

// Завершение одним кликом
await page.screenshot({ path: join(OUT, `${SCENARIO}-before-end.png`) });
const clickAt = Date.now();
const endBtn = page.getByRole("button", { name: "Завершить звонок" }).first();
const box = await endBtn.boundingBox().catch(() => null);
const vp = page.viewportSize();
check("кнопка «Завершить» видна в окне", box && vp && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height, box ? JSON.stringify(box) : "нет");
await endBtn.click({ timeout: 3000 }).catch(() => {});
let endedAt = null;
for (let i = 0; i < 40 && !endedAt; i++) { endedAt = rows(`select ended_at from calls where id='${callId}'`)[0]?.ended_at ?? null; if (!endedAt) await sleep(100); }
check("звонок завершён ≤ 3 с после клика", endedAt && endedAt - clickAt <= 3000, endedAt ? `${endedAt - clickAt} мс` : "не завершился");
await page.screenshot({ path: join(OUT, `${SCENARIO}-after-end.png`) });
await browser.close();
const passed = result.checks.every((c) => c.ok);
console.log(`RESULT ${SCENARIO} ${passed ? "PASS" : "FAIL"} ${callId} ${JSON.stringify(result.checks.filter((c) => !c.ok).map((c) => c.name))}`);
process.exit(passed ? 0 : 1);
