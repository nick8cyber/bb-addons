#!/usr/bin/env node
// PLUG-372 · provider-web-gemini: E2E-матрица генерируемых файлов (image/video/slides/pdf/docx/xlsx/canvas) через Neon
//
// Live E2E acceptance run of contract §4.5 + §2.2 item 7 of docs/specs/provider-argon.md.
// Checks 7 types:
// 1. image (Imagen)
// 2. video (Veo) — primary pro account, fallback to an ultra-tier account if locked/refused
// 3. slides (Google Slides / pptx / pdf)
// 4. pdf
// 5. docx (Google Doc)
// 6. xlsx (Таблица)
// 7. canvas / report artifact

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const driverPath =
  process.env.GEMINI_DRIVER_PATH ||
  path.join(
    os.homedir(),
    '.local/share/web-gemini/src/gemini-driver.js',
  );
const geminiDriver = require(driverPath);
const {
  sendPrompt,
  findGeneratedFileCandidates,
  findTurnTarget,
  getPlaywright,
} = geminiDriver;

// Chrome binary resolves via GEMINI_CHROME_BIN (set externally) or the driver's
// own lookup; no host-specific build path is baked into this script.
process.env.GEMINI_PARK_IDLE = '0'; // Keep page open for post-turn DOM analysis

const DOWNLOADS_DIR = '/tmp/wg-e2e-downloads';
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const RESULTS_PATH = '/tmp/wg-e2e-matrix-results.json';
const THREAD_STORAGE_RESULTS = process.env.BB_THREAD_STORAGE
  ? path.join(process.env.BB_THREAD_STORAGE, 'matrix-results.json')
  : null;

// Account matrix is not published: real account ids, CDP ports, tiers and
// profile directories come from an external config — either
// `~/.config/plug-372-e2e-accounts.json` ({"pro": {...}, "ultra": {...}})
// or the PLUG372_ACCOUNTS_JSON env var with the same JSON shape.
// The repo keeps only placeholders.
function loadExternalAccounts() {
  try {
    if (process.env.PLUG372_ACCOUNTS_JSON) {
      return JSON.parse(process.env.PLUG372_ACCOUNTS_JSON);
    }
    const cfgPath = path.join(os.homedir(), '.config/plug-372-e2e-accounts.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch (err) {
    console.warn(`Accounts config ignored: ${err.message}`);
  }
  return {};
}

const ACCOUNTS = {
  pro: {
    cdpPort: 'XXXX',
    accountId: 'acc-pro',
    tier: 'pro',
    profile: path.join(os.homedir(), '.config/chrome-profile-a'),
  },
  ultra: {
    cdpPort: 'XXXX',
    accountId: 'acc-ultra',
    tier: 'ultra',
    profile: path.join(os.homedir(), '.config/chrome-profile-b'),
  },
  ...loadExternalAccounts(),
};

function requireAccount(key) {
  const acc = ACCOUNTS[key];
  if (
    !acc ||
    !acc.cdpPort || acc.cdpPort === 'XXXX' ||
    !acc.accountId || acc.accountId === 'acc-pro' || acc.accountId === 'acc-ultra' ||
    !acc.profile
  ) {
    throw new Error(
      `Account '${key}' is not configured — provide cdpPort, accountId and profile in ~/.config/plug-372-e2e-accounts.json or PLUG372_ACCOUNTS_JSON`
    );
  }
  return acc;
}

const TEST_TYPES = [
  {
    key: 'image',
    name: 'Изображение (Imagen)',
    prompt: 'сгенерируй изображение милого рыжего котенка в космическом шлеме на луне',
    ...ACCOUNTS.pro,
  },
  {
    key: 'video',
    name: 'Видео (Veo)',
    prompt: 'сгенерируй короткое видео красивого водопада в горах',
    ...ACCOUNTS.pro,
    fallbackAccount: ACCOUNTS.ultra,
  },
  {
    key: 'slides',
    name: 'Презентация / Google Slides',
    prompt: 'Создай презентацию из 3 слайдов на тему "Искусственный интеллект" и предоставь ссылку или возможность экспорта/скачивания (pptx или pdf)',
    ...ACCOUNTS.pro,
  },
  {
    key: 'pdf',
    name: 'PDF-документ',
    prompt: 'Сформируй документ с кратким отчетом о погоде и предоставь его для скачивания в формате PDF',
    ...ACCOUNTS.pro,
  },
  {
    key: 'docx',
    name: 'Документ Google Doc → docx',
    prompt: 'Создай документ с шаблоном договора оказания IT-услуг и предоставь кнопку или ссылку экспорта в Google Doc или скачивания как docx',
    ...ACCOUNTS.pro,
  },
  {
    key: 'xlsx',
    name: 'Таблица → xlsx',
    prompt: 'Создай подробную таблицу расходов бюджета на месяц и предоставь кнопку или ссылку экспорта в Google Таблицы или скачивания как файл xlsx',
    ...ACCOUNTS.pro,
  },
  {
    key: 'canvas',
    name: 'Canvas / report-артефакт',
    prompt: 'Создай интерактивный отчет (canvas/холст) с графиком или таблицей и дай возможность экспортировать или скачать его как файл',
    ...ACCOUNTS.pro,
  },
];

async function inspectPostTurnDOM(cdpPort, convId) {
  const playwright = getPlaywright();
  let browser = null;
  try {
    browser = await playwright.chromium.connectOverCDP(`http://localhost:${cdpPort}`);
    let geminiPage = null;
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const u = p.url();
        if (u.includes('gemini.google.com')) {
          geminiPage = p;
          break;
        }
      }
      if (geminiPage) break;
    }

    if (!geminiPage) {
      return { error: 'Gemini page not found in CDP contexts' };
    }

    const analysis = await geminiPage.evaluate(
      ({ candSrc, fnSrc }) => {
        const out = {
          url: location.href,
          hasImg: false,
          imgSources: [],
          hasVideo: false,
          videoSources: [],
          hasCanvas: false,
          hasFileCard: false,
          exportButtons: [],
          allTurnButtons: [],
          allTurnLinks: [],
          candidates: [],
          messageContentLength: 0,
        };

        const findTurn = (0, eval)('(' + fnSrc + ')');
        const findCands = (0, eval)('(' + candSrc + ')');
        const target = findTurn ? findTurn(document, 0, '') : null;

        // Check overall images in response
        const imgs = target
          ? target.querySelectorAll('img, generated-image, .image-container')
          : document.querySelectorAll('model-response:last-of-type img, generated-image');
        if (imgs && imgs.length > 0) {
          out.hasImg = true;
          for (const img of imgs) {
            const src = img.src || img.getAttribute('src') || '';
            const alt = img.alt || img.getAttribute('alt') || '';
            const tag = img.tagName.toLowerCase();
            out.imgSources.push({ tag, src: src.slice(0, 100), alt: alt.slice(0, 100) });
          }
        }

        // Check video
        const videos = target
          ? target.querySelectorAll('video, [data-video-id], .video-player')
          : document.querySelectorAll('model-response:last-of-type video');
        if (videos && videos.length > 0) {
          out.hasVideo = true;
          for (const v of videos) {
            out.videoSources.push({
              tag: v.tagName.toLowerCase(),
              src: (v.src || v.getAttribute('src') || '').slice(0, 100),
            });
          }
        }

        // Check canvas
        const canvasEls = target
          ? target.querySelectorAll('canvas, [data-artifact-id], .artifact-card, .canvas-container')
          : document.querySelectorAll('canvas');
        if (canvasEls && canvasEls.length > 0) {
          out.hasCanvas = true;
        }

        // Check file cards
        const fileCards = (target || document).querySelectorAll(
          '.file-card, .file-chip, [data-file-id], [data-mime-type], [data-attachment-id]'
        );
        if (fileCards && fileCards.length > 0) {
          out.hasFileCard = true;
        }

        // List turn buttons and links
        const scope = target || document.querySelector('model-response:last-of-type') || document;
        for (const b of scope.querySelectorAll('button, [role="button"]')) {
          const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim();
          if (label) {
            out.allTurnButtons.push(label.slice(0, 80));
            if (/export|download|экспорт|скачать|sheets|docs|slides|таблиц|документ|презентац/i.test(label)) {
              out.exportButtons.push(label.slice(0, 100));
            }
          }
        }

        for (const a of scope.querySelectorAll('a[href]')) {
          const href = a.href || '';
          const label = ((a.getAttribute('aria-label') || '') + ' ' + (a.innerText || '')).trim();
          out.allTurnLinks.push({ href: href.slice(0, 100), label: label.slice(0, 60) });
          if (/export|download|экспорт|скачать|drive\.google|docs\.google/i.test(label + ' ' + href)) {
            out.exportButtons.push(`Link: ${label} -> ${href.slice(0, 80)}`);
          }
        }

        if (target && findCands) {
          try {
            out.candidates = findCands(target, { detectOnly: false });
          } catch (e) {
            out.candidatesError = e.message;
          }
        }

        const mc = scope.querySelector('message-content');
        if (mc) {
          out.messageContentLength = (mc.innerText || '').length;
        }

        return out;
      },
      {
        candSrc: findGeneratedFileCandidates.toString(),
        fnSrc: findTurnTarget.toString(),
      }
    );

    // Park tab back to about:blank
    await geminiPage.goto('about:blank', { timeout: 5000 }).catch(() => {});
    return analysis;
  } catch (err) {
    return { error: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function runTestType(t) {
  console.log(`\n==================================================`);
  console.log(`Running Type: [${t.key}] ${t.name}`);
  console.log(`Prompt: "${t.prompt}"`);
  console.log(`Account: ${t.accountId} (CDP ${t.cdpPort}, tier ${t.tier})`);
  console.log(`==================================================`);

  const initialDownloads = fs.readdirSync(DOWNLOADS_DIR);
  const startTime = Date.now();
  let sendResult = null;
  let sendError = null;
  let usedAccount = t.accountId;
  let usedPort = t.cdpPort;
  let usedTier = t.tier;
  let usedProfile = t.profile;

  const trySend = async (opts) => {
    return await sendPrompt({
      prompt: opts.prompt,
      model: 'neon',
      isNewChat: true,
      cdpPort: opts.cdpPort,
      accountId: opts.accountId,
      tier: opts.tier,
      strictModel: true,
      profile: opts.profile,
      downloadsDir: DOWNLOADS_DIR,
      sessionId: `e2e-${opts.key}`,
    });
  };

  try {
    sendResult = await trySend({
      prompt: t.prompt,
      cdpPort: t.cdpPort,
      accountId: t.accountId,
      tier: t.tier,
      profile: t.profile,
      key: t.key,
    });
  } catch (err) {
    sendError = err;
    console.warn(`[${t.key}] Error on primary account (${t.accountId}):`, err.message);
  }

  // If video and primary (pro) account didn't generate video (error or refusal in text)
  let fallbackResult = null;
  if (t.key === 'video' && t.fallbackAccount) {
    const isProRefusal = !sendResult || (sendResult.text && /не могу.*видео|cannot.*video|работа.*только с текст/i.test(sendResult.text));
    if (sendError || isProRefusal) {
      console.log(`[video] Pro account unable to generate video (${sendError ? sendError.message : 'refused in text'}). Testing on fallback ${t.fallbackAccount.tier} account...`);
      await new Promise((r) => setTimeout(r, 15000));
      try {
        fallbackResult = await trySend({
          prompt: t.prompt,
          cdpPort: t.fallbackAccount.cdpPort,
          accountId: t.fallbackAccount.accountId,
          tier: t.fallbackAccount.tier,
          profile: t.fallbackAccount.profile,
          key: `${t.key}-fallback`,
        });
      } catch (fbErr) {
        console.warn(`[video] Fallback run error:`, fbErr.message);
        fallbackResult = { error: fbErr.message };
      }
    }
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);

  // Post-turn DOM inspection via CDP for primary
  const domAnalysis = await inspectPostTurnDOM(usedPort, sendResult?.convId);

  let fallbackDomAnalysis = null;
  if (fallbackResult && !fallbackResult.error) {
    fallbackDomAnalysis = await inspectPostTurnDOM(t.fallbackAccount.cdpPort, fallbackResult.convId);
  }

  // Inspect physical downloads directory
  const currentDownloads = fs.readdirSync(DOWNLOADS_DIR);
  const newFiles = currentDownloads.filter((f) => !initialDownloads.includes(f));
  const newFileDetails = newFiles.map((f) => {
    const p = path.join(DOWNLOADS_DIR, f);
    const st = fs.statSync(p);
    return {
      fileName: f,
      sizeBytes: st.size,
      isPart: f.endsWith('.part'),
      path: p,
    };
  });

  const record = {
    key: t.key,
    name: t.name,
    prompt: t.prompt,
    account: usedAccount,
    cdpPort: usedPort,
    tier: usedTier,
    durationSec,
    uiGeneratedFile: Boolean(
      domAnalysis.hasImg ||
      domAnalysis.hasVideo ||
      domAnalysis.hasCanvas ||
      domAnalysis.hasFileCard ||
      domAnalysis.exportButtons?.length > 0 ||
      (sendResult?.files && sendResult.files.length > 0)
    ),
    uiDetails: {
      hasImg: domAnalysis.hasImg,
      imgCount: domAnalysis.imgSources?.length || 0,
      hasVideo: domAnalysis.hasVideo,
      hasCanvas: domAnalysis.hasCanvas,
      hasFileCard: domAnalysis.hasFileCard,
      exportButtons: domAnalysis.exportButtons || [],
    },
    domCandidateAppeared: Boolean(domAnalysis.candidates && domAnalysis.candidates.length > 0),
    domCandidates: domAnalysis.candidates || [],
    collectedFiles: sendResult?.files || [],
    skippedDownloads: sendResult?.skippedDownloads || [],
    diskFiles: newFileDetails,
    sendError: sendError ? sendError.message : null,
    textSnippet: sendResult?.text ? sendResult.text.slice(0, 300) : null,
    convId: sendResult?.convId || null,
    ...(fallbackResult
      ? {
          fallbackRun: {
            account: t.fallbackAccount.accountId,
            cdpPort: t.fallbackAccount.cdpPort,
            tier: t.fallbackAccount.tier,
            error: fallbackResult.error || null,
            textSnippet: fallbackResult.text ? fallbackResult.text.slice(0, 300) : null,
            convId: fallbackResult.convId || null,
            collectedFiles: fallbackResult.files || [],
            skippedDownloads: fallbackResult.skippedDownloads || [],
            domAnalysis: fallbackDomAnalysis,
            uiGeneratedFile: Boolean(
              fallbackDomAnalysis?.hasVideo ||
              fallbackDomAnalysis?.hasImg ||
              fallbackDomAnalysis?.exportButtons?.length > 0 ||
              (fallbackResult.files && fallbackResult.files.length > 0)
            ),
          },
        }
      : {}),
  };

  console.log(`\nResult for [${t.key}]:`);
  console.log(`  UI generated file/artifact: ${record.uiGeneratedFile}`);
  console.log(`  DOM download candidate appeared: ${record.domCandidateAppeared}`);
  console.log(`  collectGeneratedFiles res.files count: ${record.collectedFiles.length}`);
  console.log(`  res.skippedDownloads count: ${record.skippedDownloads.length}`);
  console.log(`  Disk files in ${DOWNLOADS_DIR}: ${record.diskFiles.length}`);
  if (record.diskFiles.length > 0) {
    record.diskFiles.forEach((df) =>
      console.log(`    -> ${df.fileName} (${df.sizeBytes} bytes, isPart=${df.isPart})`)
    );
  }
  if (record.skippedDownloads.length > 0) {
    record.skippedDownloads.forEach((sk) =>
      console.log(`    -> Skipped: ${sk.name} [reason: ${sk.reason}]`)
    );
  }

  return record;
}

async function main() {
  const targetKey = process.argv[2]; // optional: specific key
  let results = [];
  try {
    if (fs.existsSync(RESULTS_PATH)) {
      results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    }
  } catch {}

  const typesToRun = targetKey
    ? TEST_TYPES.filter((t) => t.key === targetKey)
    : TEST_TYPES;

  if (typesToRun.length === 0) {
    console.error(`Unknown test type: ${targetKey}. Available: ${TEST_TYPES.map((t) => t.key).join(', ')}`);
    process.exit(1);
  }

  // Validate all required accounts up front — a missing fallback account
  // records a skipped row instead of aborting the whole matrix run.
  requireAccount('pro');
  const ultraAvailable = (() => {
    try {
      requireAccount('ultra');
      return true;
    } catch {
      return false;
    }
  })();

  for (let i = 0; i < typesToRun.length; i++) {
    const t = typesToRun[i];
    const runT = t.fallbackAccount && !ultraAvailable
      ? (console.warn(`[${t.key}] fallback 'ultra' account not configured — running primary only`), { ...t, fallbackAccount: null })
      : t;
    const rec = await runTestType(runT);
    // Merge or replace record
    const existingIdx = results.findIndex((r) => r.key === rec.key);
    if (existingIdx >= 0) {
      results[existingIdx] = rec;
    } else {
      results.push(rec);
    }

    // Save intermediate results
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    if (THREAD_STORAGE_RESULTS) {
      fs.writeFileSync(THREAD_STORAGE_RESULTS, JSON.stringify(results, null, 2));
    }

    if (i < typesToRun.length - 1) {
      console.log(`\nWaiting 20s before next test type (quota rate limit protection)...`);
      await new Promise((r) => setTimeout(r, 20000));
    }
  }

  console.log(`\n==================================================`);
  console.log(`ALL DONE. Results written to ${RESULTS_PATH}`);
  console.log(`==================================================`);
}

main().catch((err) => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
