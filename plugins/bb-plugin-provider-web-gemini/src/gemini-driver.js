const path = require('path');
const fs = require('fs');
const os = require('os');
const profileManager = require('./profile-manager');
const usageLimits = require('./usage-limits');
const { isFileToolReply, verifyFileResponse } = require('./file-envelope.cjs');

let driverHooks = null;
function _setDriverHooks(hooks) {
  driverHooks = hooks;
}

let CDP_PORT = process.env.GEMINI_CDP_PORT || '9222';
const cdpUrl = (port) => `http://localhost:${port ?? CDP_PORT}`;
function setCdpPort(port) { CDP_PORT = String(port); }

// Extended reset time regexp supporting date, tomorrow, English and Russian
const RESET_REGEX_EXTENDED = /(?:Limit resets (?:on\s+)?(?:[A-Za-z]+\s+\d{1,2},?\s+|tomorrow\s+)?(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:AM|PM)?|(?:Лимит\s+)?(?:обновится|сбросится)[^0-9]*\d{1,2}:\d{2})/i;

// \b only sees ASCII word chars — Cyrillic needs letter-aware boundaries.
function wordMatch(text, w) {
  const esc = String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
}
const GEMINI_APP_URL = 'https://gemini.google.com/app';

function getPlaywright() {
  try {
    return require('playwright');
  } catch (e) {}
  try {
    return require('playwright-core');
  } catch (e) {}

  try {
    const localWebGemini = path.join(os.homedir(), '.local/share/web-gemini/node_modules/playwright-core');
    if (fs.existsSync(localWebGemini)) return require(localWebGemini);
    const localShared = path.join(os.homedir(), '.local/share/argon-gemini/node_modules/playwright-core');
    if (fs.existsSync(localShared)) return require(localShared);
  } catch (e) {}

  const { execSync } = require('child_process');
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    if (globalRoot) {
      const p = path.join(globalRoot, 'playwright');
      if (fs.existsSync(p)) return require(p);
      const pc = path.join(globalRoot, 'playwright-core');
      if (fs.existsSync(pc)) return require(pc);
    }
  } catch (e) {}

  try {
    const nvmDir = path.join(process.env.HOME || os.homedir(), '.nvm/versions/node');
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      for (const v of versions) {
        const candidate = path.join(nvmDir, v, 'lib/node_modules/playwright');
        if (fs.existsSync(candidate)) {
          return require(candidate);
        }
        const candidateCore = path.join(nvmDir, v, 'lib/node_modules/playwright-core');
        if (fs.existsSync(candidateCore)) {
          return require(candidateCore);
        }
      }
    }
  } catch (e) {}

  throw new Error('Playwright could not be resolved in local or global modules');
}

async function isCdpReady(port) {
  try {
    const res = await fetch(`${cdpUrl(port)}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function getRunningChromeMode(port) {
  try {
    const { execSync } = require('child_process');
    const ps = execSync('ps aux', { encoding: 'utf8' });
    const p = port ?? CDP_PORT;
    const lines = ps.split('\n').filter((l) => new RegExp(`--remote-debugging-port=${p}(\\s|$)`).test(l) && (l.includes('/chrome') || l.includes('xvfb-run')));
    if (lines.length === 0) return null;
    const fullCmd = lines.join(' ');
    if (fullCmd.includes('--headless=new') || fullCmd.includes('--ozone-platform=headless')) {
      return 'native';
    }
    if (fullCmd.includes('--ozone-platform=x11') || fullCmd.includes('xvfb-run') || fullCmd.includes('Xvfb')) {
      return 'xvfb';
    }
    return 'visible';
  } catch {
    return null;
  }
}

function getRunningChromeProfile(port) {
  try {
    const { execSync } = require('child_process');
    const ps = execSync('ps aux', { encoding: 'utf8' });
    const p = port ?? CDP_PORT;
    const lines = ps.split('\n').filter((l) => new RegExp(`--remote-debugging-port=${p}(\\s|$)`).test(l) && (l.includes('/chrome') || l.includes('xvfb-run')));
    if (lines.length === 0) return null;
    const fullCmd = lines.join(' ');
    const userDirMatch = fullCmd.match(/--user-data-dir=([^\s]+)/);
    const profDirMatch = fullCmd.match(/--profile-directory=([^\s]+)/);
    return {
      userDataDir: userDirMatch ? userDirMatch[1] : null,
      profileDir: profDirMatch ? profDirMatch[1] : 'Default'
    };
  } catch {
    return null;
  }
}

async function stopChrome(port) {
  const { execSync } = require('child_process');
  try {
    execSync(`pkill -f 'remote-debugging-port=${port ?? CDP_PORT}([[:space:]]|$)' || true`);
    await new Promise((r) => setTimeout(r, 800));
  } catch {}
}

async function ensureChrome(opts = {}) {
  let headlessMode = null;
  let forceRestart = false;
  let requestedProfile = null;

  if (typeof opts === 'string') {
    headlessMode = opts;
  } else if (opts && typeof opts === 'object') {
    headlessMode = opts.headless;
    forceRestart = Boolean(opts.restart);
    requestedProfile = opts.profile;
  }

  if (!headlessMode && process.env.GEMINI_HEADLESS) {
    headlessMode = process.env.GEMINI_HEADLESS.toLowerCase().trim();
  }

  let targetMode = null;
  if (headlessMode === true || headlessMode === 'xvfb' || headlessMode === 'xvfb-run') {
    targetMode = 'xvfb';
  } else if (headlessMode === 'native' || headlessMode === 'new' || headlessMode === 'builtin') {
    targetMode = 'native';
  } else if (
    headlessMode === 'visible' ||
    headlessMode === 'headful' ||
    headlessMode === false ||
    headlessMode === 'false'
  ) {
    targetMode = 'visible';
  }

  const port = opts && typeof opts === 'object' && opts.port ? String(opts.port) : CDP_PORT;
  const targetProfile = profileManager.resolveProfile(requestedProfile);
  const currentProfile = getRunningChromeProfile(port);
  const currentMode = getRunningChromeMode(port);
  const cdpUp = await isCdpReady(port);

  const profileMatches =
    currentProfile &&
    currentProfile.userDataDir === targetProfile.userDataDir &&
    currentProfile.profileDir === targetProfile.profileDir;

  const modeMatches = !targetMode || currentMode === targetMode;

  if (cdpUp && !forceRestart && profileMatches && modeMatches) {
    return targetProfile;
  }

  if (process.env.GEMINI_NO_AUTOSPAWN) {
    throw new Error(
      `GEMINI_NO_AUTOSPAWN: refusing to ${cdpUp ? 'restart' : 'spawn'} chrome on :${port} ` +
        `(cdpUp=${cdpUp}, profileMatches=${Boolean(profileMatches)}, modeMatches=${modeMatches})`
    );
  }

  await stopChrome(port);

  const { spawn } = require('child_process');
  const chromeBin = process.env.GEMINI_CHROME_BIN || process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';

  const baseArgs = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${targetProfile.userDataDir}`,
    `--profile-directory=${targetProfile.profileDir}`,
    GEMINI_APP_URL
  ];

  let proc;
  const launchMode = targetMode || 'native';
  if (launchMode === 'native') {
    const nativeEnv = { ...process.env };
    delete nativeEnv.WAYLAND_DISPLAY;
    delete nativeEnv.X_PRIVILEGED_WAYLAND_SOCKET;
    proc = spawn(
      chromeBin,
      ['--headless=new', '--ozone-platform=headless', ...baseArgs],
      { detached: true, stdio: 'ignore', env: nativeEnv }
    );
  } else if (launchMode === 'xvfb') {
    const xvfbEnv = { ...process.env };
    delete xvfbEnv.WAYLAND_DISPLAY;
    delete xvfbEnv.X_PRIVILEGED_WAYLAND_SOCKET;
    proc = spawn(
      'xvfb-run',
      ['-a', chromeBin, '--ozone-platform=x11', ...baseArgs],
      { detached: true, stdio: 'ignore', env: xvfbEnv }
    );
  } else {
    proc = spawn(
      chromeBin,
      baseArgs,
      { detached: true, stdio: 'ignore' }
    );
  }
  // Missing binary or spawn failure must not crash the host process — the
  // 'error' event is fatal when unhandled. Surface it as a normal failure.
  let spawnErr = null;
  proc.on('error', (e) => { spawnErr = e; });
  proc.unref();

  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (spawnErr) throw new Error(`failed to launch chrome (${chromeBin}): ${spawnErr.message}`);
    await new Promise((r) => setTimeout(r, 500));
    if (await isCdpReady(port)) return;
  }
  throw new Error(`Chrome CDP failed to become ready on port ${port} within 15s (mode: ${targetMode || 'visible'})`);
}

async function checkRobotVerification(page, options = {}) {
  const url = page.url();
  const isSorryUrl = url.includes('google.com/sorry');

  let hasCaptchaText = false;
  try {
    hasCaptchaText = await safeEval(page, () => {
      const text = document.body ? document.body.innerText.toLowerCase() : '';
      return (
        text.includes('unusual traffic from your computer network') ||
        text.includes('systems have detected unusual traffic') ||
        text.includes('our systems have detected unusual traffic') ||
        text.includes('verify you\'re human') ||
        text.includes('verify that you are not a robot') ||
        document.querySelector('#captcha-form, iframe[src*="recaptcha"], iframe[src*="challenge"]') !== null
      );
    });
  } catch {}

  if (!isSorryUrl && !hasCaptchaText) {
    return { verified: true };
  }

  console.warn('[gemini] Google Robot Verification (CAPTCHA) detected on:', url);

  // 1. Attempt automatic click on standard checkbox if present
  try {
    for (const frame of page.frames()) {
      if (frame.url().includes('recaptcha') || frame.url().includes('challenge')) {
        const checkbox = await frame.$('.recaptcha-checkbox-border, #recaptcha-anchor, [role="checkbox"]');
        if (checkbox) {
          console.warn('[gemini] Attempting to click verification checkbox...');
          await checkbox.click({ timeout: 5000 });
          await page.waitForTimeout(2000);
          if (!page.url().includes('google.com/sorry')) {
            console.warn('[gemini] Verification checkbox succeeded.');
            return { verified: true };
          }
        }
      }
    }
  } catch {}

  // 2. If running in visible mode or user opted into waiting
  const runningMode = getRunningChromeMode(options.port);
  if (runningMode === 'visible' || options.waitForVerification) {
    console.warn('\n===============================================================');
    console.warn('[!] ACTION REQUIRED: Please solve the Google verification in the browser.');
    console.warn('Waiting up to 120 seconds for verification to complete...');
    console.warn('===============================================================\n');
    const startWait = Date.now();
    while (Date.now() - startWait < 120000) {
      await page.waitForTimeout(2000);
      const curUrl = page.url();
      if (curUrl.startsWith('https://gemini.google.com') && !curUrl.includes('google.com/sorry')) {
        console.warn('[gemini] Verification resolved by user! Continuing execution.');
        return { verified: true };
      }
    }
  }

  // 3. Headless or timeout: stop work cleanly and alert user
  const runningProfile = getRunningChromeProfile(options.port);
  const profileHint = runningProfile ? `gemini --login ${runningProfile.profileDir}` : 'gemini --login';
  throw new Error(
    `Google Robot Verification (CAPTCHA) Required.\n` +
    `Google flagged the connection with an anti-bot challenge on: ${url}\n\n` +
    `Resolution Steps:\n` +
    `1. Launch visible browser to complete the verification:\n` +
    `   ${profileHint}   OR   gemini --visible "retry prompt"\n` +
    `2. Or switch to an alternate Google profile:\n` +
    `   gemini -p <other-profile> "your prompt"\n`
  );
}

async function getGeminiPage(browser, options = {}) {
  let geminiPage = null;
  let blankPage = null;
  const pagesToClose = [];

  for (const ctx of browser.contexts()) {
    const pages = ctx.pages();
    for (const page of pages) {
      const url = page.url();
      if (url.startsWith('https://gemini.google.com')) {
        if (!geminiPage) {
          geminiPage = page;
        } else {
          // Close duplicate Gemini tabs to prevent process and tab bloat
          pagesToClose.push(page);
        }
      } else if (url === 'about:blank') {
        if (!blankPage && !geminiPage) {
          blankPage = page;
        } else {
          pagesToClose.push(page);
        }
      }
    }
  }

  for (const p of pagesToClose) {
    await p.close().catch(() => {});
  }

  const targetPage = geminiPage || blankPage;
  if (targetPage) {
    await checkRobotVerification(targetPage, options);
    await dismissOverlays(targetPage);
    return targetPage;
  }

  let ctx = browser.contexts()[0];
  if (!ctx) ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded' });
  await checkRobotVerification(page, options);
  await dismissOverlays(page);
  return page;
}

async function getPickerButton(page) {
  const selector =
    'button[aria-label*="mode picker" i], button.input-area-switch, button[aria-label*="currently" i], ' +
    'button[aria-label*="режим" i], button[aria-label*="используется" i]';
  const btn = await page.waitForSelector(selector, { timeout: 8000 }).catch(() => null);
  if (btn) return btn;
  // Fallback: a visible button whose text/aria-label names a known model.
  const handle = await page.evaluateHandle(() => {
    const vis = (el) => !!(el && el.offsetParent !== null);
    const re = /argon|neon|deeper analysis|hydrogen|flash|flash-lite|\bpro\b|lite|carbon/i;
    return [...document.querySelectorAll('button,[role="button"]')]
      .filter(vis)
      .find((e) => re.test(e.innerText + ' ' + (e.getAttribute('aria-label') || '')));
  });
  const el = handle.asElement ? handle.asElement() : null;
  if (!el) throw new Error('Model picker button not found');
  return el;
}

class ModelUnavailable extends Error {
  constructor(kind, detail) {
    super(`${kind}-unavailable: ${detail}`);
    this.code = 'ARGON_MODEL_UNAVAILABLE';
    this.kind = kind;
  }
}

// Gemini SPA navigation destroys the JS execution context mid-poll — retry a
// few times instead of killing an already-sent turn.
function isContextDestroyed(err) {
  return /Execution context (was destroyed|is not available)|Cannot find context|detached [Ff]rame|frame was detached|Cannot find object|Inspected target navigated/i.test(
    String(err && (err.message || err))
  );
}

async function safeEval(page, fn, arg, retries = 3) {
  for (let i = 0; ; i++) {
    try {
      return arg === undefined ? await page.evaluate(fn) : await page.evaluate(fn, arg);
    } catch (err) {
      if (!isContextDestroyed(err) || i >= retries) throw err;
      await page.waitForTimeout(300).catch(() => {});
    }
  }
}

async function safeQuery(page, selector, retries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await page.$(selector);
    } catch (err) {
      if (!isContextDestroyed(err) || i >= retries) throw err;
      await page.waitForTimeout(300).catch(() => {});
    }
  }
}

async function safeQueryAll(page, selector, retries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await page.$$(selector);
    } catch (err) {
      if (!isContextDestroyed(err) || i >= retries) throw err;
      await page.waitForTimeout(300).catch(() => {});
    }
  }
}

// PLUG-281: >~100KB prompts hang execCommand('insertText') — fail fast before
// any page work. Unset → 100000 default; non-positive env → no limit.
function webGeminiMaxPromptBytes() {
  const raw = process.env.WEB_GEMINI_MAX_PROMPT_BYTES ?? process.env.ARGON_MAX_PROMPT_BYTES;
  if (raw == null || raw === '') return 100_000;
  const v = Number(raw);
  // NaN/garbage → default; non-positive → explicit "no limit".
  return Number.isFinite(v) ? (v > 0 ? v : Number.POSITIVE_INFINITY) : 100_000;
}

function throwIfPromptTooLarge(prompt, fieldMaxBytes = null) {
  const bytes = Buffer.byteLength(prompt || '', 'utf8');
  // A real maxlength on the web input field lowers the effective limit.
  const ml = Number(fieldMaxBytes);
  const limit = Number.isFinite(ml) && ml > 0 ? Math.min(webGeminiMaxPromptBytes(), ml) : webGeminiMaxPromptBytes();
  if (bytes > limit) {
    const err = new Error(
      `prompt too large: ${bytes} bytes exceeds limit ${limit} bytes (WEB_GEMINI_MAX_PROMPT_BYTES). Shrink the request and retry.`
    );
    err.code = 'WEB_GEMINI_PROMPT_TOO_LARGE';
    err.maxPromptBytes = limit;
    throw err;
  }
}

// PLUG-282: exact lock-badge predicate. The old substring check
// `className.includes('lock')` false-positived on 'unlock', 'lock_open',
// 'mat-icon-lock-reset' etc. A real lock badge is a *visible* icon whose
// Material identity is exactly 'lock'. Self-contained so Playwright can
// serialize it into the page and unit tests can call it on a fake DOM.
// PLUG-324: check item's own data-mode-id attribute for upsell prefix (e.g. upsell_MODE_CATEGORY_ULTRA).
function menuItemHasLockIcon(el) {
  if (!el) return false;
  const rawModeId =
    (typeof el.getAttribute === 'function' ? el.getAttribute('data-mode-id') : null) ||
    (el.dataset && el.dataset.modeId) ||
    '';
  const modeId = String(rawModeId).trim().toLowerCase();
  if (modeId.startsWith('upsell_')) return true;

  const icons = typeof el.querySelectorAll === 'function'
    ? [...el.querySelectorAll('mat-icon, [class*="icon"], gem-icon')]
    : [];
  return icons.some((icon) => {
    if (icon.offsetParent === null) return false;
    const t = (icon.innerText || '').trim().toLowerCase();
    if (t === 'lock') return true;
    const attr = (
      (typeof icon.getAttribute === 'function' && (icon.getAttribute('data-mat-icon-name') || icon.getAttribute('aria-label'))) ||
      ''
    ).trim().toLowerCase();
    if (attr === 'lock' || attr === 'lock-filled') return true;
    const cls =
      typeof icon.className === 'string'
        ? icon.className
        : String((icon.className && icon.className.baseVal) || '');
    return cls.split(/\s+/).some((c) => c === 'lock' || c === 'lock-filled');
  });
}

// PLUG-282: a post-click dialog counts as lock proof only when it carries an
// explicit plan-change CTA. A generic promo popup with price text
// ("попробуйте …/мес") is not a lock. Self-contained for page.evaluate:
// Playwright invokes fn() with no args, so the document comes from the
// page's global — `globalThis.document` also resolves safely under Node
// tests where `document` is not a declared identifier.
function upsellDialogConfirmsLock(doc = globalThis.document) {
  const PLAN_CTA =
    /сменить (план|подписку)|сменить тариф|change (plan|subscription)|upgrade|перейти на (тариф|план|ultra|pro)|оформить подписку|перейти на платную/i;
  const DISMISS = /не сейчас|not now|no thanks|maybe later/i;
  if (!doc || typeof doc.querySelectorAll !== 'function') return false;
  const dlgs = [...doc.querySelectorAll('mat-dialog-container, [role="dialog"]')]
    .filter((e) => e.offsetParent !== null);
  for (const dlg of dlgs) {
    // Skip dialogs that were already open before the model-item click — a
    // pre-existing promo with a plan CTA is not a response to this click.
    if (typeof dlg.getAttribute === 'function' && dlg.getAttribute('data-web-gemini-pre-click') !== null) continue;
    const actions = [...dlg.querySelectorAll('button,[role="button"],a')];
    if (!actions.some((x) => PLAN_CTA.test((x.innerText || '').trim()))) continue;
    const dismiss = actions.find((x) => DISMISS.test((x.innerText || '').trim()));
    if (dismiss) dismiss.click();
    return true;
  }
  return false;
}

// PLUG-282: tag dialogs already on screen so the post-click upsell check only
// counts a dialog that appeared as a direct response to the click. Hidden
// dialogs are left untagged — a pre-existing hidden element shown in response
// to the click is still a click response. Self-contained for page.evaluate.
function markVisibleDialogs(doc = globalThis.document) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return 0;
  let n = 0;
  for (const d of doc.querySelectorAll('mat-dialog-container, [role="dialog"]')) {
    if (d.offsetParent === null || typeof d.setAttribute !== 'function') continue;
    d.setAttribute('data-web-gemini-pre-click', '1');
    n += 1;
  }
  return n;
}

async function selectModelAndThinking(page, model, thinking, strict = false) {
  const isMenuOpen = async () => {
    const menu = await safeQuery(page, 'gem-menu[role="menu"]:visible, gem-menu-item[data-mode-id]:visible, [role="menuitem"]:visible');
    return menu !== null;
  };

  const openMenu = async () => {
    if (await isMenuOpen()) return;
    const btn = await getPickerButton(page);
    await btn.click({ timeout: 8000 });
    await page.waitForSelector('gem-menu-item[data-mode-id]:visible, gem-menu-item:visible, [role="menuitem"]:visible', { timeout: 8000 });
    await page.waitForTimeout(300);
  };

  if (model) {
    try {
      const btn = await getPickerButton(page);
      const btnText = (await btn.innerText()).trim().toLowerCase();
      const btnAria = ((await btn.getAttribute('aria-label')) || '').toLowerCase();
      const m = model.toLowerCase();
      const modelKeywords = {
        neon: ['neon', 'deeper analysis', 'глубокий анализ', 'argon', 'код и анализ'],
        argon: ['neon', 'deeper analysis', 'глубокий анализ', 'argon', 'код и анализ'],
        carbon: ['carbon', 'code & complex work', 'code and complex work', 'самые сложные задачи'],
        hydrogen: ['hydrogen', 'повседневные дела'],
        pro: ['pro', 'исследования'],
        'flash-lite': ['flash-lite', 'lite', 'быстрые ответы'],
        lite: ['flash-lite', 'lite', 'быстрые ответы'],
        flash: ['flash'],
        fast: ['flash-lite', 'lite', 'быстрые ответы', 'flash'],
      }[m] || [m];

      const alreadySelected = (() => {
        if (m === 'flash' || m === 'fast') {
          if (btnText.includes('lite') || btnAria.includes('lite')) return false;
          return wordMatch(btnText, 'flash') || wordMatch(btnAria, 'flash');
        }
        return modelKeywords.some(
          (kw) => wordMatch(btnText, kw) || wordMatch(btnAria, kw) || btnText.includes(kw) || btnAria.includes(kw)
        );
      })();

      if (!alreadySelected) {
        await openMenu();
        const items = await safeQueryAll(page, 'gem-menu-item[data-mode-id]:visible, [role="menuitem"]:visible, .mat-mdc-menu-item:visible');
        let clicked = false;
        for (const item of items) {
          const rawText = await item.innerText();
          // Item layout varies: "ModelName" (EN) or "RU description\nVER ModelName"
          // — check every line, not just the first.
          const lines = rawText.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
          const hasWord = (w) => lines.some((l) => wordMatch(l, w) || l.includes(w));
          const matches =
            (m === 'lite' || m === 'flash-lite')
              ? hasWord('flash-lite') || hasWord('lite') || hasWord('быстрые ответы')
              : (m === 'flash' || m === 'fast')
                ? hasWord('flash') && !lines.some((l) => l.includes('lite'))
                : modelKeywords.some((kw) => hasWord(kw));

          if (matches) {
            // Check for lock icon before clicking
            const isLocked = await item.evaluate(menuItemHasLockIcon);
            if (isLocked) {
              if (strict) {
                const err = new ModelUnavailable('model', `${model} locked: paid upgrade required`);
                err.isLocked = true;
                err.lockedModel = m;
                throw err;
              }
              console.warn(`[gemini-driver] Model "${model}" is locked (paid upgrade required).`);
              break;
            }

            const isDisabled = await item.evaluate(
              (el) =>
                el.hasAttribute('disabled') ||
                el.getAttribute('aria-disabled') === 'true' ||
                el.classList.contains('mat-mdc-menu-item-disabled')
            );
            if (isDisabled) {
              const resetMatch = rawText.match(RESET_REGEX_EXTENDED);
              if (strict) {
                throw new ModelUnavailable('model', `${model} rate-limited (${resetMatch ? resetMatch[0] : 'limit reached'})`);
              }
              console.warn(
                `[gemini] Model "${model}" is currently rate-limited (${resetMatch ? resetMatch[0] : 'limit reached'}). Continuing with available model.`
              );
            } else {
              if (strict) await safeEval(page, markVisibleDialogs);
              await item.click({ timeout: 5000 });
              clicked = true;
              if (strict) {
                // Locked models are clickable: the click opens a paid-upgrade
                // dialog instead of selecting. PLUG-282: a dialog is lock
                // proof only with an explicit plan-change CTA, and only when
                // the model did NOT get selected — a promo popup alongside a
                // successful selection is not a lock.
                await page.waitForTimeout(500);
                const selectedNow = await (async () => {
                  try {
                    const b2 = await getPickerButton(page);
                    const t2 = (await b2.innerText()).trim().toLowerCase();
                    const a2 = ((await b2.getAttribute('aria-label')) || '').toLowerCase();
                    if (m === 'flash' || m === 'fast') {
                      if (t2.includes('lite') || a2.includes('lite')) return false;
                      return wordMatch(t2, 'flash') || wordMatch(a2, 'flash');
                    }
                    return modelKeywords.some(
                      (kw) => wordMatch(t2, kw) || wordMatch(a2, kw) || t2.includes(kw) || a2.includes(kw)
                    );
                  } catch {
                    return false;
                  }
                })();
                const upsell = selectedNow ? false : await safeEval(page, upsellDialogConfirmsLock);
                if (upsell) {
                  const err = new ModelUnavailable('model', `${model} locked: paid upgrade required`);
                  err.isLocked = true;
                  err.lockedModel = m;
                  throw err;
                }
              }
            }
            break;
          }
        }
        if (!clicked) {
          if (strict) throw new ModelUnavailable('model', `${model} not in picker`);
          await page.keyboard.press('Escape').catch(() => {});
        }
        await page.waitForTimeout(400);
      }
    } catch (err) {
      if (err instanceof ModelUnavailable) throw err;
      if (strict) {
        // PLUG-286: selector/timeout/navigation failures are NOT DOM proof
        // the model is missing — rethrow as-is so the pool sees a transient
        // error instead of parking the account 6h as model-unavailable.
        throw err;
      }
      console.warn(`[gemini-driver] Failed to select model "${model}":`, err.message);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  if (thinking) {
    try {
      const thinkingAliases = {
        low: ['low', 'низкий'],
        medium: ['medium', 'средний'],
        high: ['high', 'высокий']
      };
      const btn = await getPickerButton(page);
      const btnText = (await btn.innerText()).trim();
      const btnAria = (await btn.getAttribute('aria-label')) || '';
      const targetThinking = thinking.toLowerCase();
      const wanted = thinkingAliases[targetThinking] || [targetThinking];
      const alreadySelected = wanted.some(
        (w) => wordMatch(btnText, w) || wordMatch(btnAria, w)
      );

      if (!alreadySelected) {
        await openMenu();

        // Expand Thinking level submenu
        const thinkingTrigger = await safeQuery(page,
          '[value="thinking_level"], [role="menuitem"]:has-text("Thinking level"), gem-menu-item:has-text("Thinking level"), gem-menu-item:has-text("Уровень рассуждений"), [role="menuitem"]:has-text("Уровень рассуждений")'
        );
        if (thinkingTrigger) {
          await thinkingTrigger.hover({ timeout: 8000 });
          await page.waitForTimeout(300);
          const expanded = await thinkingTrigger.getAttribute('aria-expanded');
          if (expanded !== 'true') {
            // Overlay backdrop can transiently cover the trigger while the
            // menu animates — retry short clicks instead of one 30s stall.
            let trigClicked = false;
            for (let a = 0; a < 3 && !trigClicked; a++) {
              try {
                await thinkingTrigger.click({ timeout: 5000 });
                trigClicked = true;
              } catch {
                await page.waitForTimeout(700);
                try { await thinkingTrigger.click({ timeout: 2000, force: true }); trigClicked = true; } catch {}
              }
            }
            if (!trigClicked) console.warn('[gemini-driver] Thinking trigger click blocked by overlay.');
            await page.waitForTimeout(300);
          }

          const submenuId = await thinkingTrigger.getAttribute('aria-controls');
          const subSelector = submenuId
            ? `#${submenuId} gem-menu-item, #${submenuId} [role="menuitem"], .submenu-container gem-menu-item, .submenu-container [role="menuitem"]`
            : `.submenu-container gem-menu-item, [role="menuitem"]`;

          const items = await safeQueryAll(page, subSelector);
          let clicked = false;
          for (const item of items) {
            const rawText = (await item.innerText()).trim();
            const text = rawText.toLowerCase();
            const matches = wanted.some(
              (w) => wordMatch(text, w) || text.startsWith(w)
            );
            if (!/thinking level|рассужден/i.test(rawText.split('\n')[0]) && matches) {
              const isDisabled = await item.evaluate(
                (el) =>
                  el.hasAttribute('disabled') ||
                  el.getAttribute('aria-disabled') === 'true' ||
                  el.classList.contains('mat-mdc-menu-item-disabled')
              );
              if (isDisabled) {
                const resetMatch = rawText.match(RESET_REGEX_EXTENDED);
                if (strict) {
                  throw new ModelUnavailable(
                    'thinking',
                    `${thinking} thinking level is rate-limited (${resetMatch ? resetMatch[0] : 'temporarily unavailable'})`
                  );
                }
                console.warn(
                  `[gemini] Thinking level "${thinking}" is currently rate-limited (${resetMatch ? resetMatch[0] : 'limit reached'}). Continuing with available level.`
                );
              } else {
                await item.click({ timeout: 5000 });
                clicked = true;
              }
              break;
            }
          }

          if (!clicked) {
            if (strict) throw new ModelUnavailable('thinking', `${thinking} level not found`);
            console.warn(`[gemini-driver] Thinking option "${thinking}" not found in menu.`);
          }
          await page.waitForTimeout(300);
        } else {
          if (strict) throw new ModelUnavailable('thinking', 'level trigger not in menu');
          console.warn('[gemini-driver] Thinking level trigger item not found in menu.');
        }

        if (await isMenuOpen()) {
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    } catch (err) {
      if (err instanceof ModelUnavailable) throw err;
      if (strict) {
        // PLUG-286: same as model selection — timeouts/navigation stay
        // transient; ModelUnavailable is only thrown on DOM-proven absence.
        throw err;
      }
      console.warn(`[gemini-driver] Failed to select thinking level "${thinking}":`, err.message);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
}

async function stopGeneration(page) {
  if (!page) return;
  try {
    const stopBtn = await safeQuery(
      page,
      'button[aria-label*="Stop" i], button[aria-label*="Остановить" i], button[aria-label*="Прекратить" i], button[data-test-id="stop-button"], button[data-test-id*="stop" i], .stop-button'
    );
    if (stopBtn) {
      await stopBtn.click({ timeout: 2000 }).catch(() => {});
    }
  } catch {}
}

function findTurnTarget(doc, idx, promptPrefix) {
  const responses = doc.querySelectorAll('model-response');
  const target = responses[idx];
  if (!target) return null;
  const queries = doc.querySelectorAll('user-query');
  if (queries.length === 0) return null;
  const lastQuery = queries[queries.length - 1];
  if (!lastQuery) return null;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  if (promptPrefix && !norm(lastQuery.innerText).includes(norm(promptPrefix).slice(0, 40))) {
    return null;
  }
  const NodeObj = typeof Node !== 'undefined' ? Node : { DOCUMENT_POSITION_FOLLOWING: 4 };
  if (!(lastQuery.compareDocumentPosition(target) & NodeObj.DOCUMENT_POSITION_FOLLOWING)) {
    return null;
  }
  return target;
}

function checkTurnStatus(doc, idx, promptPrefix) {
  if (!doc) {
    return {
      targetFound: false,
      hasStopButton: false,
      isBusyOrThinking: false,
      hasFinishedContent: false,
      hasActionButtons: false,
      currentText: null,
    };
  }

  const findFn =
    (typeof window !== 'undefined' && (window.__webGeminiFindTurnTarget || window.__argonFindTurnTarget)) ||
    (typeof findTurnTarget !== 'undefined' ? findTurnTarget : null);
  const target = typeof findFn === 'function' ? findFn(doc, idx, promptPrefix) : null;

  const stopBtnSelector = [
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Остановить" i]',
    'button[aria-label*="Прекратить" i]',
    'button[data-test-id="stop-button"]',
    'button[data-test-id*="stop" i]',
    '.stop-button',
  ].join(', ');
  const stopEl = doc.querySelector(stopBtnSelector);
  const hasStopButton =
    stopEl !== null &&
    !stopEl.disabled &&
    stopEl.getAttribute('aria-disabled') !== 'true';

  const busySelector = [
    '[aria-busy="true"]',
    'mat-spinner',
    'mat-progress-bar',
    '[role="progressbar"]',
    '.spinner',
    '.loading-spinner',
    '.mat-mdc-progress-spinner',
    '.mat-mdc-progress-bar',
    '[data-test-id*="spinner" i]',
    '[data-test-id*="loader" i]',
    '[data-test-id*="loading" i]',
    '.shimmer',
    '[class*="shimmer" i]',
    'sparkle-animation',
    '[class*="sparkle-anim" i]',
    '.animated-sparkle',
    '.loading-dots',
    '[class*="loading-dot" i]',
    'thinking-indicator',
    '.thinking-indicator',
    '[data-test-id*="thinking-indicator" i]',
    '[class*="thinking-spinner" i]',
    '[class*="thinking-process-spinner" i]',
  ].join(', ');

  let isBusyOrThinking = false;
  if (target) {
    if (target.getAttribute('aria-busy') === 'true' || target.querySelector(busySelector) !== null) {
      isBusyOrThinking = true;
    }
  }
  if (!isBusyOrThinking) {
    const globalBusy = doc.querySelector(
      '.conversation-container [aria-busy="true"], main [aria-busy="true"], .input-area [aria-busy="true"]'
    );
    if (globalBusy) isBusyOrThinking = true;
  }

  let currentText = null;
  let hasFinishedContent = false;
  let hasActionButtons = false;

  if (target) {
    const mc = target.querySelector('message-content');
    if (mc) {
      currentText = { src: 'mc', text: mc.innerText || '' };
    } else {
      currentText = { src: 'raw', text: target.innerText || '' };
    }

    const hasText = mc ? (mc.innerText || '').trim().length > 0 : false;
    const hasImg =
      target.querySelector(
        'generated-image, img.generated-image, message-content img, .image-container img[src*="googleusercontent"], .image-container img[src*="blob:"], .image-container img[src*="data:image"]'
      ) !== null;
    hasFinishedContent = hasText || hasImg;

    const actionSelector = [
      'response-feedback',
      '.response-feedback',
      '.actions-container',
      '.luminous-actions-container',
      'message-actions',
      '[data-test-id="response-actions"]',
      '[data-test-id="message-actions"]',
      'button[aria-label*="Copy" i]',
      'button[aria-label*="Копировать" i]',
      'button[data-test-id="copy-button"]',
      'button[data-test-id*="copy" i]',
      'button[aria-label*="Good response" i]',
      'button[aria-label*="Хороший ответ" i]',
      'button[aria-label*="Thumbs up" i]',
      'button[aria-label*="Нравится" i]',
      'button[data-test-id*="thumb" i]',
      'button[data-test-id*="like" i]',
      'button[aria-label*="Bad response" i]',
      'button[aria-label*="Плохой ответ" i]',
      'button[aria-label*="Share" i]',
      'button[aria-label*="Поделиться" i]',
    ].join(', ');
    hasActionButtons = target.querySelector(actionSelector) !== null;
  }

  return {
    targetFound: target !== null,
    hasStopButton,
    isBusyOrThinking,
    hasFinishedContent,
    hasActionButtons,
    currentText,
  };
}

function isTurnComplete(status, { stableMs = 0, stableDurationMs = 500, fallbackDurationMs = 5000 } = {}) {
  if (!status || !status.targetFound) return false;
  if (status.hasStopButton) return false;
  if (status.isBusyOrThinking) return false;
  if (!status.hasFinishedContent) return false;

  if (status.hasActionButtons) {
    return stableMs >= stableDurationMs;
  }
  return stableMs >= fallbackDurationMs;
}

async function waitForHistoryStabilization(
  page,
  convId,
  { intervalMs = 350, ceilingMs = 10000, throwIfCancelled = null, requireHistory = false } = {}
) {
  if (!convId) {
    return (await safeQueryAll(page, 'model-response')).length;
  }
  const deadline = Date.now() + ceilingMs;
  let prevCount = (await safeQueryAll(page, 'model-response')).length;
  let stableMeasurements = 0;
  while (Date.now() < deadline) {
    if (page.waitForTimeout) {
      await page.waitForTimeout(intervalMs);
    } else {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (throwIfCancelled) await throwIfCancelled();
    const current = (await safeQueryAll(page, 'model-response')).length;
    if (current === prevCount) {
      stableMeasurements++;
      if (stableMeasurements >= 2 && (!requireHistory || current > 0)) {
        return current;
      }
    } else {
      stableMeasurements = 0;
      prevCount = current;
    }
  }
  return (await safeQueryAll(page, 'model-response')).length;
}

function fileResponseDom(marker) {
  const queries = [...document.querySelectorAll('user-query')];
  const matches = queries.filter((query) => query.textContent.includes(marker));
  if (!matches.length) return null;
  if (matches.length !== 1) return { invalid: 'multiple matching user messages' };
  const query = matches[0];
  const next = queries[queries.indexOf(query) + 1];
  const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & 4);
  const responses = [...document.querySelectorAll('model-response')].filter((node) =>
    follows(query, node) && (!next || follows(node, next)));
  if (!responses.length) return null;
  const messages = responses.flatMap((node) => [...node.querySelectorAll('message-content')]);
  if (responses.length !== 1 || messages.length > 1) return { invalid: 'multiple model messages for the file response' };
  if (!messages.length) return null;
  const message = messages[0];
  const id = /^message-content-id-(r_[a-z0-9]+)$/i.exec(message.id)?.[1];
  if (!id) return null;
  const blocks = [...message.querySelectorAll('pre code, code-block code, pre')]
    .filter((node) => !node.matches('pre') || !node.querySelector('code'));
  if (blocks.length > 1) return { invalid: 'multiple code blocks in the file response' };
  if (blocks.length === 1) {
    const outside = message.cloneNode(true);
    for (const block of outside.querySelectorAll('code-block, pre')) block.remove();
    if (outside.textContent.trim()) return { invalid: 'text outside the file response code block' };
  }
  return { id, text: blocks[0]?.textContent };
}

function fileResponseHistory(body, convId, marker) {
  const frames = usageLimits.extractWrbFrames(body).filter((frame) => frame[1] === 'hNvQHb');
  if (frames.length !== 1) return null;
  const [turns] = JSON.parse(frames[0][2]);
  const matches = turns.filter(([[conversationId], , query]) =>
    conversationId === 'c_' + convId && query?.[0]?.[0]?.includes(marker));
  if (!matches.length) return null;
  if (matches.length !== 1) return { invalid: 'multiple saved messages for the file response' };
  const [[, id], , , [candidates, , , selected]] = matches[0];
  const chosen = candidates.filter(([candidateId]) => candidateId === selected);
  if (chosen.length > 1) return { invalid: 'multiple selected history answers' };
  const parts = chosen[0]?.[1];
  if (parts?.length > 1) return { invalid: 'multiple parts in the saved file response' };
  return { id, text: parts?.[0] };
}

async function captureFileChannels(page, convId, marker, throwIfCancelled) {
  const dom = await safeEval(page, fileResponseDom, marker).catch(() => null);
  if (dom?.invalid || !/^[a-f0-9]+$/i.test(convId ?? '')) return { dom };
  let rpc;
  try {
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return url.origin === 'https://gemini.google.com' &&
          url.pathname === '/_/BardChatUi/data/batchexecute' && url.searchParams.get('rpcids') === 'hNvQHb';
      }, { timeout: 10_000 }),
      page.goto('https://gemini.google.com/app/' + convId, { waitUntil: 'domcontentloaded', timeout: 10_000 }),
    ]);
    if (response.ok()) rpc = fileResponseHistory(await response.text(), convId, marker);
  } catch {}
  await throwIfCancelled();
  return { rpc, dom };
}

async function captureFileResponse(page, convId, { nonce, marker }, throwIfCancelled) {
  const captured = await captureFileChannels(page, convId, marker, throwIfCancelled);
  if (!verifyFileResponse(captured, nonce).recapture) return captured;
  // The history navigation above may have just made the DOM available.
  await page.locator('model-response message-content').last().waitFor({ timeout: 5_000 }).catch(() => {});
  await throwIfCancelled();
  return captureFileChannels(page, convId, marker, throwIfCancelled);
}

async function sendPrompt({
  prompt,
  model,
  thinking,
  isNewChat = false,
  convId = null,
  signal = null,
  onChunk = null,
  headless = null,
  profile = null,
  restart = false,
  ephemeral = false,
  file = null,
  files = null,
  requireFullDelivery = false,
  onSubmitted = null,
  waitForVerification = false,
  download = null,
  sessionId = null,
  downloadsDir = null,
  cdpPort = null,
  strictModel = false,
  strict = false,
  shouldCancel = null,
  backend = null,
  accountId = null,
  tier = null,
  stateDir = null,
  verifyConversation = false,
  fileCapture = null,
}) {
  const isStrict = Boolean(strict || strictModel);
  throwIfPromptTooLarge(prompt);
  const promptPrefix = prompt.replace(/\s+/g, ' ').trim().slice(0, 40);
  // Port-local: never read the module-global CDP_PORT here. A cancelled send
  // finishing after the queue moved on must still only touch its own backend.
  const port = cdpPort != null ? String(cdpPort) : CDP_PORT;
  let page = null;
  const throwIfCancelled = async () => {
    if ((signal && signal.aborted) || (shouldCancel && shouldCancel())) {
      if (page) await stopGeneration(page);
      const e = new Error('prompt cancelled by user');
      e.code = 'ARGON_CANCELLED';
      throw e;
    }
  };
  await throwIfCancelled();
  if (driverHooks?.ensureChrome) {
    await driverHooks.ensureChrome({ headless, profile, restart, port });
  } else {
    await ensureChrome({ headless, profile, restart, port });
  }
  await throwIfCancelled();

  const playwright = driverHooks?.getPlaywright ? driverHooks.getPlaywright() : getPlaywright();
  const browser = driverHooks?.connectOverCDP
    ? await driverHooks.connectOverCDP(cdpUrl(port))
    : await playwright.chromium.connectOverCDP(cdpUrl(port));

  let resObj = null;
  let returnedConvId = convId;
  try {
    page = driverHooks?.getGeminiPage
      ? await driverHooks.getGeminiPage(browser, { waitForVerification, port })
      : await getGeminiPage(browser, { waitForVerification, port });
    await throwIfCancelled();

    let lastText = '';
    let rawText = null;
    let fileResponse;
    let downloadedPath = null;
    let generatedFiles = [];
    let hasGeneratedFile = false;
    let skippedDownloads = [];

    // PLUG-291: пользовательские файлы прикладываются веб-вложениями до
    // вставки текста/хода — в т.ч. на хуковом пути runTurn (тесты).
    const uploadList = Array.isArray(files) ? files : (file ? [file] : []);
    const attachFn = driverHooks && driverHooks.attachFile ? driverHooks.attachFile : attachFile;
    const upload = async () => {
      for (const f of uploadList) {
        await throwIfCancelled();
        try {
          await attachFn(page, f, { required: requireFullDelivery });
        } catch (error) {
          if (!requireFullDelivery) throw error;
          const failure = new Error('mandatory attachment upload could not be confirmed');
          failure.code = 'WEB_GEMINI_DELIVERY_FAILED';
          throw failure;
        }
      }
    };

    if (driverHooks?.runTurn) {
      await upload();
      onSubmitted?.();
      const turnRes = await driverHooks.runTurn(page);
      lastText = turnRes.text || '';
      rawText = turnRes.rawText ?? null;
      returnedConvId = turnRes.convId || convId;
      downloadedPath = turnRes.downloaded || null;
      generatedFiles = turnRes.files || [];
      skippedDownloads = turnRes.skippedDownloads || [];
    } else {
    const atSavedConversation = () => new URL(page.url()).pathname === '/app/' + convId;
    const lostConversation = () => {
      const error = new Error('saved web conversation is not reachable');
      error.code = 'WEB_GEMINI_CONVERSATION_LOST';
      return error;
    };
    if (page.url() === 'about:blank' || (convId && !atSavedConversation())) {
      const targetUrl = convId ? `https://gemini.google.com/app/${convId}` : GEMINI_APP_URL;
      await page.goto(targetUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
    } else if (isNewChat) {
      // The side-nav "new chat" button is frequently covered by overlays and
      // stalls the click for its full timeout — a plain goto is reliable.
      await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded' });
    }

    await dismissOverlays(page);
    await throwIfCancelled();
    if (verifyConversation && convId && !atSavedConversation()) throw lostConversation();

    const textboxSelector = 'div[contenteditable="true"][role="textbox"]';
    try {
      await page.waitForSelector(textboxSelector, { timeout: 15000 });
    } catch (err) {
      await dismissOverlays(page);
      await checkRobotVerification(page, { waitForVerification, port });
      await page.waitForSelector(textboxSelector, { timeout: 10000 });
    }

    // PLUG-281: if the web input exposes a real maxlength, it wins over env.
    const fieldMaxBytes = await page
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        const v = el && (el.maxLength ?? el.getAttribute?.('maxlength'));
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
      }, textboxSelector)
      .catch(() => null);
    if (fieldMaxBytes) throwIfPromptTooLarge(prompt, fieldMaxBytes);

    if (model || thinking) {
      await selectModelAndThinking(page, model, thinking, isStrict);
    }
    await throwIfCancelled();

    await upload();

    const initialCount = await waitForHistoryStabilization(page, convId, { throwIfCancelled, requireHistory: verifyConversation });

    // §7.3: проверяемое восстановление — ненулевой convId сам по себе не
    // доказывает, что разговор доступен: после навигации и стабилизации
    // истории страница обязана остаться тем же разговором. Редирект Gemini
    // на /app означает утраченный разговор — вызывающий передаёт сохранённый
    // пакет целиком в новый чат, а не продолжает в пустом.
    if (verifyConversation && convId && (!atSavedConversation() || initialCount === 0)) throw lostConversation();

    // SPA re-creates the editor node on re-renders (model menu, bootstrap) —
    // resolve it fresh each attempt and verify the text actually landed.
    let typed = false;
    let typeErr = null;
    const wantStart = prompt.replace(/\s+/g, ' ').trim().slice(0, 20);
    for (let attempt = 0; attempt < 3 && !typed; attempt++) {
      try {
        const textbox = await page.waitForSelector(textboxSelector, { timeout: 10000 });
        await textbox.click({ timeout: 5000 });
        // Wipe any leftover draft first — a retry must never append to it.
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(100);

        if (prompt.length > 500 || prompt.includes('\n')) {
          await safeEval(page, ({ sel, text }) => {
            const el = document.querySelector(sel);
            if (el) {
              el.focus();
              document.execCommand('insertText', false, text);
            }
          }, { sel: textboxSelector, text: prompt });
          await page.waitForTimeout(200);

          const gotText = await safeEval(page, (sel) => {
            return ((document.querySelector(sel) || {}).innerText || '');
          }, textboxSelector);

          if (gotText.length < Math.min(prompt.length * 0.9, prompt.length - 10)) {
            await page.keyboard.press('Control+A');
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(100);
            await page.keyboard.insertText(prompt);
            await page.waitForTimeout(200);
          }
        } else {
          await page.keyboard.insertText(prompt);
          await page.waitForTimeout(200);
        }

        typed = await safeEval(page,
          ({ sel, want, full }) => {
            const editor = document.querySelector(sel);
            const rendered = editor?.innerText ?? '';
            if (full !== null) {
              // Quill renders each plain-text line as a paragraph. innerText
              // inserts visual paragraph spacing, which is not part of the input.
              const quill = editor?.__quill ?? editor?.parentElement?.__quill;
              const saved = typeof quill?.getText === 'function' ? quill.getText() : null;
              if (saved === full + '\n') return true; // Quill's document terminator.
              const paragraphs = editor?.classList?.contains('ql-editor') && [...editor.children];
              const plain = paragraphs?.length && paragraphs.length === editor.childNodes.length &&
                paragraphs.every((node) => node.tagName === 'P');
              const text = plain ? paragraphs.map((node) => node.textContent).join('\n') : rendered;
              return text.replace(/\r\n/g, '\n') === full;
            }
            const t = rendered.replace(/\s+/g, ' ').trim();
            return want === '' ? t.length > 0 : t.startsWith(want);
          },
          { sel: textboxSelector, want: wantStart, full: requireFullDelivery ? prompt.replace(/\r\n/g, '\n') : null }
        );
        if (!typed) typeErr = new Error('prompt text did not reach the editor');
      } catch (e) {
        typeErr = e;
        await page.waitForTimeout(500);
      }
    }
    if (!typed) {
      if (!requireFullDelivery) throw typeErr;
      const error = new Error('complete task text could not be confirmed in the web editor');
      error.code = 'WEB_GEMINI_DELIVERY_FAILED';
      throw error;
    }
    await throwIfCancelled();

    const sendBtnSelector =
      'button[aria-label*="Send message" i], button[aria-label*="Отправить" i], button.send-button, button[aria-label*="сообщение" i]';
    const sendBtn = await safeQuery(page, sendBtnSelector);
    let sent = false;
    if (sendBtn && !(await sendBtn.isDisabled().catch(() => true))) {
      try {
        await sendBtn.click({ timeout: 8000 });
        sent = true;
      } catch {}
    }
    await throwIfCancelled();
    if (!sent) {
      await page.keyboard.press('Enter').catch(() => {});
    }

    // Poll manually (1s slices) so cancellation interrupts the 120s wait —
    // a bare waitForFunction can't be aborted.
    const genDeadline = Date.now() + 120000;
    for (;;) {
      await throwIfCancelled();
      const started = await safeEval(page,
        ({ idx, promptPrefix, fnSrc }) => {
          const stopBtn = document.querySelector(
            'button[aria-label*="Stop" i], button[aria-label*="Остановить" i], button[data-test-id="stop-button"]'
          );
          if (stopBtn !== null) return true;
          if (!window.__webGeminiFindTurnTarget && !window.__argonFindTurnTarget && fnSrc) {
            // Safe driver evaluation: fnSrc is findTurnTarget.toString() from gemini-driver.js
            window.__webGeminiFindTurnTarget = (0, eval)('(' + fnSrc + ')');
          }
          const fn = window.__webGeminiFindTurnTarget || window.__argonFindTurnTarget;
          return fn(document, idx, promptPrefix) !== null;
        },
        { idx: initialCount, promptPrefix, fnSrc: findTurnTarget.toString() }
      );
      if (started) break;
      if (Date.now() >= genDeadline) {
        throw new Error('generation did not start within 120s (no model-response, no stop button)');
      }
      await page.waitForTimeout(1000);
    }
    onSubmitted?.();

    lastText = '';
    let lastSrc = null;
    let stableStartTime = null;
    const STABLE_DURATION_MS = Number(process.env.WEB_GEMINI_STABLE_DURATION_MS || process.env.ARGON_STABLE_DURATION_MS) || 500;
    const STABLE_FALLBACK_MS = Number(process.env.WEB_GEMINI_STABLE_NO_ACTIONS_MS || process.env.ARGON_STABLE_NO_ACTIONS_MS) || 5000;
    const POLL_INTERVAL_MS = 200;
    const MAX_WAIT_MS = Number(process.env.GEMINI_MAX_WAIT_MS) || 900_000;
    const streamStartTime = Date.now();

    while (Date.now() - streamStartTime < MAX_WAIT_MS) {
      await throwIfCancelled();
      await page.waitForTimeout(POLL_INTERVAL_MS);

      const status = await safeEval(page,
        ({ idx, promptPrefix, fnSrc, checkSrc }) => {
          if (!window.__webGeminiFindTurnTarget && !window.__argonFindTurnTarget && fnSrc) {
            // Safe driver evaluation: fnSrc is findTurnTarget.toString() from gemini-driver.js
            window.__webGeminiFindTurnTarget = (0, eval)('(' + fnSrc + ')');
          }
          if (!window.__webGeminiCheckTurnStatus && checkSrc) {
            // Safe driver evaluation: checkSrc is checkTurnStatus.toString() from gemini-driver.js
            window.__webGeminiCheckTurnStatus = (0, eval)('(' + checkSrc + ')');
          }
          const checkFn = window.__webGeminiCheckTurnStatus;
          if (checkFn) {
            return checkFn(document, idx, promptPrefix);
          }
          const fn = window.__webGeminiFindTurnTarget || window.__argonFindTurnTarget;
          const target = fn ? fn(document, idx, promptPrefix) : null;
          if (!target) return null;
          const mc = target.querySelector('message-content');
          const src = mc ? 'mc' : 'raw';
          return {
            targetFound: true,
            hasStopButton: document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Остановить" i]') !== null,
            isBusyOrThinking: false,
            hasFinishedContent: (mc?.innerText || '').trim().length > 0,
            hasActionButtons: false,
            currentText: { src, text: ((mc || target).innerText || '') },
          };
        },
        {
          idx: initialCount,
          promptPrefix,
          fnSrc: findTurnTarget.toString(),
          checkSrc: checkTurnStatus.toString(),
        }
      );

      if (!status || !status.targetFound) {
        stableStartTime = null;
        continue;
      }

      const currentText = status.currentText;
      if (currentText !== null && currentText.text.length) {
        if (currentText.src !== lastSrc || !currentText.text.startsWith(lastText)) {
          lastText = '';
        }
        lastSrc = currentText.src;
        if (currentText.text.length > lastText.length) {
          const chunk = currentText.text.slice(lastText.length);
          // 'raw' pre-mc text carries "Show thinking…" chrome — stream it as
          // the answer's tail later via the mc prefix replay instead.
          if (currentText.src === 'mc' && onChunk && typeof onChunk === 'function') {
            onChunk(chunk);
          }
          lastText = currentText.text;
          stableStartTime = null;
        }
      }

      const stopButton = await safeQuery(
        page,
        'button[aria-label*="Stop" i], button[aria-label*="Остановить" i], button[aria-label*="Прекратить" i], button[data-test-id="stop-button"], button[data-test-id*="stop" i]'
      );

      const effectiveStatus = {
        ...status,
        hasStopButton: status.hasStopButton || Boolean(stopButton),
      };

      if (!effectiveStatus.hasStopButton && !effectiveStatus.isBusyOrThinking && effectiveStatus.hasFinishedContent) {
        if (stableStartTime === null) {
          stableStartTime = Date.now();
        } else {
          const stableMs = Date.now() - stableStartTime;
          if (isTurnComplete(effectiveStatus, { stableMs, stableDurationMs: STABLE_DURATION_MS, fallbackDurationMs: STABLE_FALLBACK_MS })) {
            if (process.env.WEB_GEMINI_DEBUG || process.env.ARGON_DEBUG) {
              console.log(`[web-gemini] stream complete: length=${lastText.length}, actions=${effectiveStatus.hasActionButtons}, stableMs=${stableMs}`);
            }
            break;
          }
        }
      } else {
        stableStartTime = null;
      }
    }

    // Hit the cap mid-generation → the answer is truncated, not complete.
    if (Date.now() - streamStartTime >= MAX_WAIT_MS && (await safeQuery(page,
      'button[aria-label*="Stop" i], button[aria-label*="Остановить" i], button[aria-label*="Прекратить" i], button[data-test-id="stop-button"], button[data-test-id*="stop" i]'
    ))) {
      await stopGeneration(page);
      const e = new Error(`generation still running after ${MAX_WAIT_MS / 1000}s cap — answer truncated`);
      e.code = 'WEB_GEMINI_STREAM_TIMEOUT';
      throw e;
    }

    // Final check for the latest message-content text
    try {
      const finalText = await safeEval(page,
        ({ idx, promptPrefix, fnSrc }) => {
          const fn = window.__webGeminiFindTurnTarget || window.__argonFindTurnTarget;
          if (!fn) return null;
          const target = fn(document, idx, promptPrefix);
          if (!target) return null;
          const mc = target.querySelector('message-content');
          return mc ? mc.innerText : null;
        },
        { idx: initialCount, promptPrefix, fnSrc: findTurnTarget.toString() }
      );
      if (finalText && finalText.length > 0) {
        if (finalText.length > lastText.length && onChunk && typeof onChunk === 'function') {
          onChunk(finalText.slice(lastText.length));
        }
        lastText = finalText;
      }
    } catch {}

    returnedConvId = convId;
    if (isNewChat) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const u = page.url();
        const match = u.match(/\/app\/([a-f0-9]{8,})/i) || u.match(/\/app\/([a-zA-Z0-9_-]+)/);
        if (match && match[1] && match[1] !== 'new') {
          returnedConvId = match[1];
          break;
        }
        const domId = await safeEval(page, () => {
          const a = document.querySelector(
            'gem-nav-list-item[data-test-id="conversation"] a[href*="/app/"], gem-nav-list-item a[href*="/app/"], a[href*="/app/"]'
          );
          if (!a) return null;
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/app\/([a-f0-9]{8,})/i) || href.match(/\/app\/([a-zA-Z0-9_-]+)/);
          return m && m[1] && m[1] !== 'new' ? m[1] : null;
        }).catch(() => null);
        if (domId) {
          returnedConvId = domId;
          break;
        }
        await page.waitForTimeout(200);
      }
    }

    if (downloadsDir || requireFullDelivery) {
      // PLUG-291: файлы, сгенерированные в ответе, скачиваются post-turn —
      // пока DOM текущего ответа ещё жив (до ephemeral-удаления и парковки).
      const coll = await collectGeneratedFiles(page, {
        dir: downloadsDir,
        sessionId: sessionId || returnedConvId || 'dl',
        turnIndex: initialCount,
        promptPrefix,
        throwIfCancelled,
        detectOnly: requireFullDelivery,
      }).catch((err) => {
        console.warn('[gemini] collectGeneratedFiles error:', err && err.message);
        return { files: [], skipped: [] };
      });
      generatedFiles = coll.files || [];
      skippedDownloads = coll.skipped || [];
      hasGeneratedFile = Boolean(coll.hasGeneratedFile);
    }

    if (fileCapture && !isFileToolReply(rawText || lastText)) {
      fileResponse = await captureFileResponse(page, returnedConvId, fileCapture, throwIfCancelled);
    }

    if (ephemeral) {
      try {
        const url = page.url();
        const match = url.match(/\/app\/([a-zA-Z0-9_-]+)/);
        if (match && match[1]) {
          await deleteConversationInternal(page, match[1]).catch(() => {});
        }
      } catch {}
    }

    if (download) {
      downloadedPath = await downloadGeneratedMedia(page, download).catch((err) => {
        console.warn('[gemini] Download error:', err.message);
        return null;
      });
    }
    }

    resObj = new String(lastText);
    resObj.text = lastText;
    if (typeof rawText === 'string') resObj.rawText = rawText;
    if (fileResponse) resObj.fileResponse = fileResponse;
    resObj.thinking = null;
    resObj.meta = {};
    resObj.convId = returnedConvId;
    resObj.downloaded = downloadedPath;
    resObj.files = generatedFiles;
    if (hasGeneratedFile) resObj.hasGeneratedFile = true;
    resObj.skippedDownloads = skippedDownloads;

    return resObj;
  } finally {
    // Capture usage limits post-turn on every turn (including rate-limited / failed turns)
    // before parking tab on about:blank
    try {
      if (page && !page.isClosed?.() && typeof page.url === 'function' && page.url().includes('gemini.google.com')) {
        const timeoutMs = Number(process.env.WEB_GEMINI_USAGE_TIMEOUT_MS || process.env.ARGON_USAGE_TIMEOUT_MS || 10_000);
        await Promise.race([
          usageLimits.captureUsageLimits(page, {
            accountId: accountId || (backend && backend.id) || profile,
            backend,
            stateDir,
            tier: tier || (backend && backend.tier),
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('captureUsageLimits timeout')), timeoutMs)
          ),
        ]);
      }
    } catch (err) {
      if (process.env.WEB_GEMINI_DEBUG || process.env.ARGON_DEBUG) {
        console.warn('[argon] captureUsageLimits post-turn error:', err.message);
      }
    }

    if (isNewChat && !returnedConvId && page && !page.isClosed?.() && typeof page.url === 'function') {
      try {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const u = page.url();
          const match = u.match(/\/app\/([a-f0-9]{8,})/i) || u.match(/\/app\/([a-zA-Z0-9_-]+)/);
          if (match && match[1] && match[1] !== 'new') {
            returnedConvId = match[1];
            if (resObj) resObj.convId = returnedConvId;
            break;
          }
          await page.waitForTimeout(200);
        }
      } catch {}
    }

    if (page && process.env.GEMINI_PARK_IDLE !== '0') {
      await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

async function dismissOverlays(page) {
  try {
    // 0. Google consent wall ("Before you continue to Google") mounts late —
    //    retry up to ~4s until the mat-dialog-container is gone.
    for (let i = 0; i < 5; i++) {
      const consent = await safeEval(page, () => {
        const dlg = document.querySelector('mat-dialog-container, .cdk-overlay-pane [role="dialog"], .cdk-overlay-pane');
        if (!dlg || !(dlg.innerText || '').includes('Before you continue')) return 'none';
        const btns = Array.from(dlg.querySelectorAll('button,[role="button"],a'));
        const pick = (re) => btns.find((b) => re.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
        const reject = pick(/^reject all$/i) || pick(/reject/i);
        const accept = pick(/^accept all$/i) || pick(/accept/i) || pick(/i agree/i);
        const t = reject || accept;
        if (!t) return 'nobtn';
        t.click();
        return 'clicked';
      });
      if (consent === 'none') break;
      if (consent === 'clicked') await page.waitForTimeout(700);
      else await page.waitForTimeout(800);
    }

    // 0.5. Gemini apps opt-in banner ("Use Gemini" / "Использовать Gemini").
    //     Signed-in users who never consented are bounced from /app to the
    //     landing page until this button is clicked; the choice persists
    //     server-side, so this runs only once per account.
    for (let i = 0; i < 4; i++) {
      const useBtn = await safeEval(page, () => {
        const vis = (el) => !!(el && el.offsetParent !== null);
        const e = [...document.querySelectorAll('button,[role="button"]')]
          .filter(vis)
          .find((el) => /использовать gemini|use gemini/i.test(el.innerText));
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!useBtn) break;
      await page.mouse.click(useBtn.x, useBtn.y).catch(() => {});
      await page.waitForTimeout(1500);
    }

    // 0.7. Paid-tier upsell dialog (locked model click → "Сменить план / Не сейчас").
    //     Dismiss via the negative button; the plan is never changed.
    for (let i = 0; i < 3; i++) {
      const dismissed = await safeEval(page, () => {
        const dlgs = [...document.querySelectorAll('mat-dialog-container, [role="dialog"]')]
          .filter((e) => e.offsetParent !== null);
        const dlg = dlgs.find((d) =>
          /сменить план|change (plan|subscription)|\/\s*мес|per month|\/month/i.test(d.innerText || '')
        );
        if (!dlg) return false;
        const btn = [...dlg.querySelectorAll('button,[role="button"],a')]
          .find((b) => /не сейчас|not now|no thanks|maybe later/i.test((b.innerText || '').trim()));
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!dismissed) break;
      await page.waitForTimeout(600);
    }

    // 1. Google Cookie / Privacy Consent dialogs ("Before you continue to Google")
    const consentBtn = await safeQuery(page,
      'button:has-text("Accept all"), button:has-text("Принять все"), button:has-text("Принять всё"), [aria-label*="Accept all" i], button:has-text("I agree"), button:has-text("Согласен"), [aria-label*="I agree" i]'
    );
    if (consentBtn) {
      const isVisible = await consentBtn.isVisible().catch(() => false);
      if (isVisible) {
        await consentBtn.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
    }

    // 2. "Stay signed out" / "Dismiss" prompts
    const staySignedOutBtn = await safeQuery(page,
      'button:has-text("Stay signed out"), button:has-text("Не входить в аккаунт"), [aria-label*="Stay signed out" i], button:has-text("Dismiss"), button:has-text("No thanks"), button:has-text("Не сейчас"), button:has-text("Спасибо, не надо")'
    );
    if (staySignedOutBtn) {
      const isVisible = await staySignedOutBtn.isVisible().catch(() => false);
      if (isVisible) {
        await staySignedOutBtn.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(300);
      }
    }

    // 3. Onboarding / "Got it" / "Next" dialogs
    const gotItBtn = await safeQuery(page,
      'button:has-text("Got it"), button:has-text("Понятно"), [aria-label*="Got it" i], button:has-text("Done"), button:has-text("Готово"), [aria-label*="Done" i], button:has-text("Continue"), button:has-text("Продолжить")'
    );
    if (gotItBtn) {
      const isVisible = await gotItBtn.isVisible().catch(() => false);
      if (isVisible) {
        await gotItBtn.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(300);
      }
    }

    // 4. Any leftover CDK backdrop
    const backdrop = await safeQuery(page, '.cdk-overlay-backdrop');
    if (backdrop && (await backdrop.isVisible().catch(() => false))) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
  } catch {}
}

async function ensureSidebarOpen(page) {
  await dismissOverlays(page);
  await page.waitForSelector('side-navigation-v2, nav, [role="navigation"]', { timeout: 10000 }).catch(() => {});

  const openBtn = await safeQuery(page,
    'button[aria-label*="Open sidebar" i], button[data-test-id="side-nav-sparkle-button"][aria-label*="Open sidebar" i], button[aria-label*="Expand sidebar" i]'
  );
  if (openBtn) {
    const isVisible = await openBtn.isVisible().catch(() => false);
    if (isVisible) {
      try {
        await openBtn.click();
        await page.waitForSelector('gem-nav-list-item a[href*="/app/"]', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(300);
      } catch {}
    }
  }

  await page.waitForSelector('gem-nav-list-item a[href*="/app/"], a[href*="/app/"]', { timeout: 10000 }).catch(() => {});
}

async function listConversationsInternal(page) {
  await ensureSidebarOpen(page);
  await page
    .waitForSelector('gem-nav-list-item a[href*="/app/"], a[href*="/app/"]', { timeout: 10000 })
    .catch(() => {});
  return await safeEval(page, () => {
    const items = Array.from(
      document.querySelectorAll(
        'gem-nav-list-item[data-test-id="conversation"], gem-nav-list-item:has(a[href*="/app/"])'
      )
    );
    const seen = new Set();
    const result = [];
    let idx = 1;

    for (const item of items) {
      const a = item.querySelector('a[href*="/app/"]');
      if (!a) continue;
      const href = a.getAttribute('href') || '';
      const match = href.match(/\/app\/([a-zA-Z0-9_-]+)/);
      if (!match) continue;
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const titleEl =
        item.querySelector('.conversation-title, [data-test-id="conversation-title"], .mdc-list-item__primary-text') || a;
      let title = (titleEl ? titleEl.innerText : a.innerText || '').trim();
      const ariaLabel = a.getAttribute('aria-label');
      if (ariaLabel && (!title || title.length === 0)) {
        title = ariaLabel.trim();
      }
      title = title.split('\n')[0].trim();

      result.push({
        index: idx++,
        id,
        title,
        url: `https://gemini.google.com/app/${id}`
      });
    }
    return result;
  });
}

function resolveConversation(convs, idOrIndex) {
  if (idOrIndex === undefined || idOrIndex === null || idOrIndex === '') {
    throw new Error('Conversation index or ID is required');
  }
  const str = String(idOrIndex).trim();
  if (/^\d+$/.test(str)) {
    const idx = parseInt(str, 10);
    const byIndex = convs.find((c) => c.index === idx);
    if (byIndex) return byIndex;
  }
  const cleanId = str.replace(/^.*\/app\//, '').split(/[?#]/)[0];
  const byId = convs.find((c) => c.id === cleanId || c.id === str);
  if (byId) return byId;

  if (cleanId && cleanId.length >= 8) {
    return {
      index: null,
      id: cleanId,
      title: 'Conversation',
      url: `${GEMINI_APP_URL}/${cleanId}`
    };
  }

  throw new Error(`Conversation not found: ${idOrIndex}`);
}

async function listConversations(opts = {}) {
  await ensureChrome(opts);
  const playwright = getPlaywright();
  const browser = await playwright.chromium.connectOverCDP(cdpUrl());
  try {
    const page = await getGeminiPage(browser);
    return await listConversationsInternal(page);
  } finally {
    await browser.close();
  }
}

async function getConversationTranscript(idOrIndex, opts = {}) {
  await ensureChrome(opts);
  const playwright = getPlaywright();
  const browser = await playwright.chromium.connectOverCDP(cdpUrl());
  try {
    const page = await getGeminiPage(browser);
    const convs = await listConversationsInternal(page);
    const target = resolveConversation(convs, idOrIndex);
    const targetUrl = target.url || `${GEMINI_APP_URL}/${target.id}`;

    if (!page.url().includes(target.id)) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await page
        .waitForSelector('user-query, model-response, div[contenteditable="true"][role="textbox"]', { timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(500);
    }

    const transcriptData = await safeEval(page, async () => {
      const turnEls = Array.from(document.querySelectorAll('user-query, model-response'));
      const turns = [];

      for (let i = 0; i < turnEls.length; i++) {
        const el = turnEls[i];
        el.scrollIntoView({ behavior: 'instant', block: 'center' });

        const role = el.tagName.toLowerCase() === 'user-query' ? 'user' : 'gemini';
        let content = '';

        if (role === 'user') {
          const lines = Array.from(el.querySelectorAll('.query-text-line'));
          if (lines.length > 0) {
            content = lines
              .map((l) => l.innerText.trim())
              .filter(Boolean)
              .join('\n');
          } else {
            const clone = el.cloneNode(true);
            clone
              .querySelectorAll('.cdk-visually-hidden, button, .luminous-actions-container')
              .forEach((e) => e.remove());
            content = clone.innerText.trim();
          }
        } else {
          const mc = el.querySelector('message-content');
          if (mc) {
            content = mc.innerText.trim();
          } else {
            const clone = el.cloneNode(true);
            clone
              .querySelectorAll('.cdk-visually-hidden, button, response-feedback')
              .forEach((e) => e.remove());
            content = clone.innerText.trim();
          }
        }

        turns.push({ role, content });
      }

      const docTitle = document.title.replace(/\s*-\s*Google Gemini$/i, '').trim();
      return { docTitle, turns };
    });

    const title =
      target.title && target.title !== 'Conversation'
        ? target.title
        : transcriptData.docTitle || target.title || 'Untitled';

    return {
      id: target.id,
      title,
      url: targetUrl,
      turns: transcriptData.turns
    };
  } finally {
    await browser.close();
  }
}

async function deleteConversationInternal(page, targetId) {
  await ensureSidebarOpen(page);
  const item = await safeQuery(page, `gem-nav-list-item:has(a[href*="/app/${targetId}"])`);
  if (!item) {
    throw new Error(`Conversation element not found for ID: ${targetId}`);
  }

  await item.evaluate((el) => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
  await page.waitForTimeout(100);
  await item.hover();
  await page.waitForTimeout(100);

  const moreBtn = await item.$(
    'button[aria-label*="More options" i], button:has([data-mat-icon-name="more_vert"])'
  );
  if (!moreBtn) {
    throw new Error(`More options button not found for conversation: ${targetId}`);
  }
  await moreBtn.click();

  const deleteMenuItem = await page.waitForSelector(
    '[data-test-id="delete-button"], [role="menuitem"]:has-text("Delete"), [role="menuitem"]:has-text("Удалить")',
    { timeout: 3000 }
  );
  await deleteMenuItem.click();

  const dialog = await page.waitForSelector('mat-dialog-container', { timeout: 5000 });
  const confirmBtn = await dialog.waitForSelector('button:has-text("Delete"), button:has-text("Удалить"), [data-test-id="confirm-button"]', { timeout: 3000 });
  await confirmBtn.click();

  await dialog.waitForElementState('hidden', { timeout: 5000 }).catch(() => {});
  await item.evaluate((el) => el.remove()).catch(() => {});
  await page.waitForTimeout(500);

  return { status: 'deleted', id: targetId };
}

async function deleteConversation(idOrIndex, opts = {}) {
  await ensureChrome(opts);
  const playwright = getPlaywright();
  const browser = await playwright.chromium.connectOverCDP(cdpUrl());
  try {
    const page = await getGeminiPage(browser);
    const convs = await listConversationsInternal(page);
    const target = resolveConversation(convs, idOrIndex);
    return await deleteConversationInternal(page, target.id);
  } finally {
    await browser.close();
  }
}

async function getUploadToolsButton(page) {
  return safeQuery(page,
    'button[aria-label="Upload & tools"], button[aria-label*="Upload & tools" i], button[aria-label*="tools" i], button:has([data-mat-icon-name="plus"]), [data-test-id="upload-button"], button[aria-label*="Загрузка" i], button[aria-label*="инструменты" i], button:has([data-mat-icon-name="add"])'
  );
}

function attachmentPreviewState({ name, before }) {
  const composer = document.querySelector('div[contenteditable="true"][role="textbox"]');
  const scope = composer?.closest('input-container, .input-area, form') || document;
  const selector = 'uploader-file-preview, file-preview, mat-chip, [data-test-id*="attachment"], [class*="file-preview"]';
  const visible = [...scope.querySelectorAll(selector)].filter((preview) =>
    preview.getClientRects().length && !preview.contains(composer));
  // Count individual chips even if a container also matches the selector.
  const count = visible.filter((preview) => ![...preview.querySelectorAll(selector)]
    .some((child) => child.getClientRects().length)).length;
  if (before === undefined) return count;

  const send = document.querySelector('button[aria-label*="Send message" i], button[aria-label*="Отправить" i], button.send-button');
  if (count <= before || !send || send.disabled || send.getAttribute('aria-disabled') === 'true') return false;

  const edge = Math.floor(name.length / 4);
  const middle = name.slice(edge, name.length - edge);
  const stem = name.replace(/\.[^.]+$/, '');
  const matches = (label) => {
    const value = label?.trim();
    if (value === name) return true;
    const parts = value?.split(/…|\.{3}/);
    return parts?.length === 2 && parts[0] && parts[1] && [name, stem].some((candidate) =>
      candidate.startsWith(parts[0]) && candidate.endsWith(parts[1]) && parts[0].length + parts[1].length < candidate.length);
  };
  const named = visible.some((preview) => preview.innerText?.split('\n').some(matches) ||
    [preview, ...preview.querySelectorAll('[title], [aria-label]')].some((element) => {
      const aria = element.getAttribute('aria-label');
      return matches(element.getAttribute('title')) || matches(aria) || aria?.includes(name) ||
        (middle.length >= 8 && aria?.includes(middle));
    }));
  return { named };
}

async function attachFile(page, filePath, { required = false } = {}) {
  const fs = require('fs');
  const path = require('path');
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File to attach not found: ${filePath}`);
  }
  const before = required ? await safeEval(page, attachmentPreviewState, {}) : null;

  const btn = await getUploadToolsButton(page);
  if (!btn) {
    throw new Error('Upload & tools (+) button not found on Gemini page.');
  }

  await btn.click();
  await page.waitForTimeout(300);

  // Input-first: the "+" menu mounts a hidden DOM twin of the upload item —
  // a text-matched page.$ can pick it, the click is a no-op and no filechooser
  // ever fires. Opening the menu then driving a real (even if visually hidden)
  // input[type="file"] works regardless of menu-item duplicates.
  const fileInput = await page.waitForSelector('input[type="file"]', {
    state: 'attached',
    timeout: 8000,
  }).catch(() => null);

  if (fileInput) {
    await fileInput.setInputFiles(resolvedPath);
  } else {
    // Fallback: a VISIBLE upload item (data-test-id first, then localized text).
    const uploadItem = await safeQuery(page,
      '[data-test-id="local-images-files-uploader-button"], [role="menuitem"]:has-text("Upload files"):visible, [role="menuitem"]:has-text("Загрузить файлы"):visible, .mat-mdc-menu-item:has-text("Upload files"):visible, .mat-mdc-menu-item:has-text("Загрузить файлы"):visible'
    );
    if (!uploadItem) {
      throw new Error('"Upload files" option not found in tools menu.');
    }
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      uploadItem.click()
    ]);
    await fileChooser.setFiles(resolvedPath);
  }
  await page.waitForTimeout(1000);

  if (required) {
    const confirmation = await page.waitForFunction(attachmentPreviewState,
      { name: path.basename(resolvedPath), before }, { timeout: 15000 });
    try {
      if (!(await confirmation.jsonValue()).named) {
        console.warn('[gemini] Attachment preview appeared, but its filename could not be verified.');
      }
    } finally {
      await confirmation.dispose().catch(() => {});
    }
    return;
  }

  // Wait up to 15s for file preview chip to appear and send button to become enabled
  await page.waitForFunction(() => {
    const hasChip = document.querySelector('[aria-label*="close" i], [aria-label*="remove" i], file-preview') !== null;
    const btn = document.querySelector('button[aria-label*="Send message"], button[aria-label="Send message"], button[aria-label*="Отправить"], button.send-button');
    const btnReady = btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
    return hasChip && btnReady;
  }, { timeout: 15000 }).catch(() => {});
}

/* ---------- PLUG-291: файлы, сгенерированные Gemini в ответе ---------- */
const numEnv = (names, dflt) => {
  for (const name of [].concat(names)) {
    const v = Number(process.env[name]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return dflt;
};

function sanitizeDownloadName(name) {
  const s = String(name ?? '')
    .replace(/[\\/<>:"|?*#\x00-\x1f]/g, '_')
    .replace(/\.\./g, '_')
    .trim();
  return (s || 'file').slice(0, 120);
}

// Белый список доменов Gemini/Google — клики и выгрузки только по нему.
// googleapis.com — хостинг файлов (storage.googleapis.com и др.).
function isAllowedDownloadHost(h) {
  const x = String(h || '').toLowerCase();
  return (
    x === 'google.com' ||
    x.endsWith('.google.com') ||
    x === 'googleusercontent.com' ||
    x.endsWith('.googleusercontent.com') ||
    x === 'googleapis.com' ||
    x.endsWith('.googleapis.com')
  );
}

// Хост URL скачивания; blob:<origin>/… — хост внутри пути.
// null — хост определить не удалось (data:, нестандартная схема).
function downloadUrlHost(u) {
  try {
    const x = new URL(u);
    if (x.protocol === 'blob:') return new URL(x.pathname).hostname || null;
    return x.hostname || null;
  } catch {
    return null;
  }
}

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.ics': 'text/calendar',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

function mimeFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

function fileNameFromDisposition(disposition) {
  const h = String(disposition || '');
  const star = h.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {}
  }
  const plain = h.match(/filename\s*=\s*"?([^";]+)"?/);
  return plain ? plain[1].trim() : null;
}

/**
 * Сбор файлов, которые Gemini Web сгенерировал в текущем ответе.
 * Сканируется только DOM ответа текущего хода (findTurnTarget), никогда
 * `model-response:last-of-type` — иначе файлы прошлых ходов качались бы
 * повторно. Каналы: прямые download-URL белого списка доменов через
 * context.request и клик по кнопкам Download/Export с гонкой перехватов —
 * download-событие, новая вкладка контекста, сетевой ответ с бинарным телом
 * и fetch→blob (хук URL.createObjectURL). Ссылки вне белого списка не
 * кликаются и не выгружаются.
 */
function findGeneratedFileCandidates(target, { detectOnly = false, tagAttr = 'argon-dl' } = {}) {
  if (!target) return [];
  const FILE_EXT_RE =
    /\.(pdf|pptx?|xlsx?|docx?|csv|tsv|md|txt|zip|json|png|jpe?g|gif|svg|webp|mp3|wav|mp4|html?|ics|epub)(?:$|[?#])/i;
  const okHost = (u) => {
    try {
      const base = (typeof location !== 'undefined' && location.href) ? location.href : 'http://localhost';
      const h = new URL(u, base).hostname.toLowerCase();
      return (
        h === 'google.com' ||
        h.endsWith('.google.com') ||
        h === 'googleusercontent.com' ||
        h.endsWith('.googleusercontent.com') ||
        h === 'googleapis.com' ||
        h.endsWith('.googleapis.com')
      );
    } catch {
      return false;
    }
  };
  const out = [];
  const seen = new Set();
  const seenNodes = new Set();
  let seq = 0;
  for (const a of target.querySelectorAll('a[href]')) {
    if (seenNodes.has(a)) continue;
    const href = a.href || a.getAttribute('href') || '';
    if (!href || seen.has(href)) continue;
    if (!okHost(href)) continue;
    const hasDl = a.hasAttribute('download');
    if (detectOnly) {
      const isFileCard = Boolean(a.closest?.('.file-card, .file-chip, [data-file-id], [data-mime-type], [data-attachment-id]'));
      if (!hasDl && !isFileCard) continue;
    } else {
      const label = ((a.getAttribute('aria-label') || '') + ' ' + (a.innerText || '')).trim();
      const dlText = /download|скачать|export|экспорт/i.test(label);
      if (!hasDl && !dlText && !FILE_EXT_RE.test(href)) continue;
    }
    seen.add(href);
    seenNodes.add(a);
    const tag = `${tagAttr}-${seq++}`;
    if (a.setAttribute) a.setAttribute('data-argon-dl', tag);
    const label = ((a.getAttribute('aria-label') || '') + ' ' + (a.innerText || '')).trim();
    out.push({
      kind: 'link',
      tag,
      href,
      name: (a.getAttribute('download') || label || '').slice(0, 120),
      canClick: hasDl,
    });
  }
  for (const b of target.querySelectorAll('button, [role="button"], a:not([href])')) {
    // Дедуп по DOM-узлу: кнопка внутри уже размеченного якоря — один файл.
    // Префикс tagAttr — чужие разметки прошлых сканов не считаем своими.
    if (seenNodes.has(b)) continue;
    if (b.closest && b.closest(`[data-argon-dl^="${tagAttr}-"]`)) continue;
    const hasDl = b.hasAttribute('download');
    if (detectOnly) {
      const isFileCard = Boolean(b.closest?.('.file-card, .file-chip, [data-file-id], [data-mime-type], [data-attachment-id]'));
      if (!hasDl && !isFileCard) continue;
    } else {
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim();
      if (!/download|скачать|export|экспорт/i.test(label)) continue;
    }
    seenNodes.add(b);
    const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim();
    const tag = `${tagAttr}-${seq++}`;
    if (b.setAttribute) b.setAttribute('data-argon-dl', tag);
    out.push({ kind: 'click', tag, name: label.slice(0, 120) });
  }
  return out;
}

// Хосты, куда Gemini ведёт экспортом через Google Docs/Drive — прямой файл
// оттуда без интеграции с Drive не стянуть, фиксируем причину в skipped.
const DRIVE_GATE_HOST_RE = /^(docs|drive|sheets|slides)\.google\.com$/i;

const EXT_BY_MIME = (() => {
  const m = {};
  for (const [ext, mime] of Object.entries(MIME_BY_EXT)) {
    if (!(mime in m)) m[mime] = ext;
  }
  return m;
})();

function withExtFromMime(name, mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!base || path.extname(String(name || ''))) return name;
  const ext = EXT_BY_MIME[base];
  return ext ? `${name}${ext}` : name;
}

async function collectGeneratedFiles(page, opts = {}) {
  const dir = opts.dir;
  const files = [];
  const skipped = [];
  if ((!dir && !opts.detectOnly) || !page) return { files, skipped };
  const maxCount = numEnv(['WEB_GEMINI_MAX_DOWNLOAD_COUNT', 'ARGON_MAX_DOWNLOAD_COUNT'], 5);
  const maxBytes = numEnv(['WEB_GEMINI_MAX_DOWNLOAD_BYTES', 'ARGON_MAX_DOWNLOAD_BYTES'], 50 * 1024 * 1024);
  const nonce = `n${Date.now().toString(36)}`;

  let cands = null;
  let scanMeta = {};
  try {
    const scan = await safeEval(
      page,
      ({ idx, promptPrefix, fnSrc, candSrc, tagAttr, detectOnly }) => {
        if (!window.__argonFindTurnTarget && fnSrc) {
          window.__argonFindTurnTarget = (0, eval)('(' + fnSrc + ')');
        }
        if (!window.__argonFindGeneratedFileCandidates && candSrc) {
          window.__argonFindGeneratedFileCandidates = (0, eval)('(' + candSrc + ')');
        }
        const fn = window.__argonFindTurnTarget;
        const target = fn ? fn(document, idx, promptPrefix) : null;
        if (!target) return { candidates: [], meta: {} };
        const findCands = window.__argonFindGeneratedFileCandidates;
        const candidates = findCands ? findCands(target, { detectOnly, tagAttr }) : [];
        const meta = {};
        try {
          const txt = String(target.innerText || '');
          // Экспорт, требующий подключённого Google Drive (xlsx/Docs/Sheets/Slides).
          if (
            /(подключ\w+|connect\w*|requires?|требуется|нужно|activate)\b[\s\S]{0,80}google drive/i.test(txt) ||
            /google drive[\s\S]{0,80}(требуется|required|integration|интеграци|подключ)/i.test(txt)
          ) {
            meta.driveGate = true;
          }
          if (!candidates.length) {
            // Inline-контент без экспорта: canvas/pdf viewer, видео-превью, blob-img.
            const m =
              target.querySelector &&
              target.querySelector(
                'video, canvas, embed, object, generated-image, generated-video, .file-card, .file-chip, [data-file-id], [data-mime-type], img[src^="blob:"], img[src*="googleusercontent"]'
              );
            if (m) {
              meta.nonExportable = true;
              meta.mediaKind = String(m.tagName || 'media').toLowerCase();
            } else if (
              // Асинхронная генерация (видео): файла в этом ходе ещё нет.
              /вернитесь позже|займ(ёт|ет)\s+(?:ещё\s+)?(несколько|пару)\s+минут|come back (later|soon)|(may|might|could) take (a few|several|a couple)( more)? minutes/i.test(
                txt
              )
            ) {
              meta.nonExportable = true;
              meta.mediaKind = 'async media';
            }
          }
        } catch {}
        return { candidates, meta };
      },
      { idx: opts.turnIndex ?? 0, promptPrefix: opts.promptPrefix || '', fnSrc: findTurnTarget.toString(), candSrc: findGeneratedFileCandidates.toString(), tagAttr: nonce, detectOnly: Boolean(opts.detectOnly) }
    );
    cands = Array.isArray(scan) ? scan : (scan && scan.candidates) || null;
    scanMeta = (scan && !Array.isArray(scan) && scan.meta) || {};
  } catch {
    return { files, skipped };
  }

  if (!Array.isArray(cands) || !cands.length) {
    if (!opts.detectOnly) {
      if (scanMeta.driveGate) {
        skipped.push({ name: 'generated file', reason: 'requires Google Drive integration' });
      } else if (scanMeta.nonExportable) {
        skipped.push({
          name: `generated ${scanMeta.mediaKind || 'media'}`,
          reason: 'файл не экспортируем в этом ходе',
        });
      }
    }
    return { files, skipped };
  }
  if (opts.detectOnly) return { files, skipped, hasGeneratedFile: true };

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { files, skipped };
  }
  const sessTag = sanitizeDownloadName(opts.sessionId || 'dl');
  const ts = Date.now();
  let seq = 0;
  const destFor = (name) => path.join(dir, `${sessTag}-${ts}-${++seq}-${sanitizeDownloadName(name)}`);
  const nameFromUrl = (u) => {
    try {
      const p = new URL(u).pathname;
      return p.split('/').filter(Boolean).pop() || null;
    } catch {
      return null;
    }
  };
  const skipNote = (name, reason) =>
    skipped.push({ name: String(name || 'file').slice(0, 120), reason: String(reason).slice(0, 160) });

  // Потолок попыток: длинный хвост неудачных кандидатов по ~15–25с
  // таймаутов не должен растягивать ход на минуты (ревью PLUG-291).
  const attemptBudget = Math.max(8, maxCount * 2);
  let tries = 0;

  const CLICK_WAIT_MS = 10000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const saveBufferToFile = (nameHint, mime, body) => {
    if (body.length > maxBytes) {
      skipNote(nameHint || 'file', `too large (${body.length} bytes > ${maxBytes})`);
      return;
    }
    const name = sanitizeDownloadName(withExtFromMime(nameHint || 'file', mime));
    const dest = destFor(name);
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, dest);
    files.push({
      path: dest,
      name,
      mimeType: String(mime || '').split(';')[0].trim() || mimeFromName(name),
      sizeBytes: body.length,
    });
  };

  const nameForFetched = (headers, url, fallback) =>
    fileNameFromDisposition(headers && headers['content-disposition']) ||
    fallback ||
    nameFromUrl(url) ||
    'file';

  // Класс хоста URL скачивания: 'drive' — Google Docs/Drive (гейт, прямой
  // файл без интеграции не стянуть), 'allowed' — белый список, 'denied' —
  // посторонний хост, 'unknown' — хост определить не удалось.
  const classifyDlUrl = (url) => {
    const h = downloadUrlHost(url);
    if (!h) return 'unknown';
    if (DRIVE_GATE_HOST_RE.test(h)) return 'drive';
    return isAllowedDownloadHost(h) ? 'allowed' : 'denied';
  };

  const dlHostNote = (url) => downloadUrlHost(url) || 'unknown';

  // Кандидат «сетевой ответ = файл»: content-disposition=attachment или
  // бинарный content-type, 2xx и хост белого списка. Фоновая телеметрия
  // (batchexecute/gen_204/пиксели), иконки svg/gif и посторонние хосты до
  // резолва победителя гасятся — не должны побеждать по клику экспорта
  // (ревью PLUG-376). Хосты Docs/Drive возвращаем как кандидата — чтобы
  // зафиксировать причину Drive-гейта.
  const respFileCandidate = (resp) => {
    try {
      const url = (resp.url && resp.url()) || '';
      const h = downloadUrlHost(url);
      if (!h) return null;
      if (DRIVE_GATE_HOST_RE.test(h)) return { resp, url };
      if (!isAllowedDownloadHost(h)) return null;
      const st = typeof resp.status === 'function' ? resp.status() : null;
      if (typeof st === 'number' && (st < 200 || st >= 300)) return null;
      const hd = (resp.headers && resp.headers()) || {};
      const ct = String(hd['content-type'] || '').toLowerCase();
      const cd = String(hd['content-disposition'] || '');
      if (/attachment/i.test(cd)) return { resp, url };
      if (/gen_204|batchexecute|\/log\b|telemetry|beacon|\/collect|playlog/i.test(url)) return null;
      if (
        /^(application\/(octet-stream|zip|x-zip-compressed|pdf|msword|vnd\.|x-msdownload)|video\/|audio\/)/.test(
          ct
        ) ||
        /^image\/(?!svg|gif|x-icon|vnd\.microsoft\.icon)/.test(ct)
      ) {
        return { resp, url };
      }
      return null;
    } catch {
      return null;
    }
  };

  // Победитель гонки каналов — первый НЕ-пустой результат; ошибка или
  // таймаут отдельного канала не гасит остальные (ревью PLUG-376).
  const firstNonNull = (promises) =>
    new Promise((resolve) => {
      if (!promises.length) return resolve(null);
      let left = promises.length;
      let done = false;
      for (const pr of promises) {
        Promise.resolve(pr).then(
          (v) => {
            if (done) return;
            if (v) {
              done = true;
              resolve(v);
              return;
            }
            if (--left === 0) resolve(null);
          },
          () => {
            if (!done && --left === 0) resolve(null);
          }
        );
      }
    });

  // Извлечённый URL (новая вкладка / сетевой ответ) стягивается через
  // request-контекст браузера. Хост проверяется и до запроса, и после —
  // req.get идёт по редиректам, финальный URL может уйти с белого списка
  // или на Drive-гейт (ревью PLUG-376).
  const fetchUrlToFile = async (url, fallbackName) => {
    const name = fallbackName || nameFromUrl(url) || 'file';
    const cls0 = classifyDlUrl(url);
    if (cls0 === 'drive') {
      skipNote(name, 'requires Google Drive integration');
      return;
    }
    if (cls0 !== 'allowed') {
      skipNote(name, `host not allowed (${dlHostNote(url)})`);
      return;
    }
    const ctx = page.context && page.context();
    const req = ctx && ctx.request;
    if (!req || typeof req.get !== 'function') {
      skipNote(name, 'no request context');
      return;
    }
    try {
      const resp = await req.get(url, { timeout: 15000 });
      if (!resp.ok()) {
        skipNote(name, `http ${resp.status()}`);
        return;
      }
      const finalUrl = (typeof resp.url === 'function' && resp.url()) || url;
      const clsF = classifyDlUrl(finalUrl);
      if (clsF === 'drive') {
        skipNote(name, 'requires Google Drive integration');
        return;
      }
      if (clsF !== 'allowed') {
        skipNote(name, `host not allowed (${dlHostNote(finalUrl)})`);
        return;
      }
      const headers = resp.headers ? resp.headers() : {};
      const cl = Number(headers['content-length'] || 0);
      if (cl > maxBytes) {
        skipNote(name, `too large (${cl} bytes > ${maxBytes})`);
        return;
      }
      const body = await resp.body();
      saveBufferToFile(nameForFetched(headers, finalUrl, fallbackName), headers['content-type'], body);
    } catch (e) {
      skipNote(name, String((e && e.message) || e));
    }
  };

  const tryDownloadByClick = async (c, fallbackName) => {
    const el = await safeQuery(page, `[data-argon-dl="${c.tag}"]`);
    const candName = fallbackName || c.name || 'download';
    if (!el) {
      skipNote(candName, 'element gone');
      return;
    }
    const ctx = (typeof page.context === 'function') ? page.context() : null;
    const clickStart = Date.now();
    let settled = false;
    // Перехватчики принимают события только с начала клика — фоновая
    // телеметрия и чужие вкладки в общем контексте не должны побеждать.
    let accept = false;
    const dlEvents = [];
    const pageEvents = [];
    const respEvents = [];

    // Канал fetch→blob: страница собирает blob и «кликает» по нему —
    // download-ивента нет. Хукаем createObjectURL до клика; сам Blob
    // держим в записи — revokeObjectURL байты уже не отбирает (ревью
    // PLUG-376: паттерн create→click→revoke обгонял опрос по URL).
    try {
      await page.evaluate(({ since }) => {
        try {
          const rec = (window.__argonDlBlobs = []);
          rec.since = since;
          if (!window.__argonDlBlobHooked) {
            window.__argonDlBlobHooked = true;
            const orig = URL.createObjectURL.bind(URL);
            URL.createObjectURL = (obj) => {
              const u = orig(obj);
              try {
                (window.__argonDlBlobs || (window.__argonDlBlobs = [])).push({
                  url: u,
                  type: (obj && obj.type) || '',
                  ts: Date.now(),
                  blob: obj,
                });
              } catch {}
              return u;
            };
          }
        } catch {}
      }, { since: clickStart });
    } catch {}

    // Подписки ставятся до первой попытки клика — событие, пришедшее во
    // время клика, не теряется; снимаются в cleanupWaiters (утёкший
    // слушатель контекста закрывал чужие вкладки — ревью PLUG-376).
    let dlListener = null;
    let respListener = null;
    let pageListener = null;
    if (typeof page.on === 'function') {
      dlListener = (dl) => {
        if (accept && !settled) dlEvents.push(dl);
      };
      respListener = (resp) => {
        if (!accept || settled) return;
        const cand = respFileCandidate(resp);
        if (cand) respEvents.push(cand);
      };
      try {
        page.on('download', dlListener);
      } catch {
        dlListener = null;
      }
      try {
        page.on('response', respListener);
      } catch {
        respListener = null;
      }
    }
    if (ctx) {
      pageListener = (p) => {
        if (accept && !settled) pageEvents.push(p);
      };
      try {
        if (typeof ctx.on === 'function') ctx.on('page', pageListener);
        else if (typeof ctx.once === 'function') ctx.once('page', pageListener);
        else pageListener = null;
      } catch {
        pageListener = null;
      }
    }

    // Надёжность клика: scrollIntoView → обычный → force → dispatchEvent —
    // кнопки экспорта под оверлеями/в нестабильном состоянии падают на
    // elementHandle.click (E2E PLUG-372).
    try {
      await (el.scrollIntoViewIfNeeded && el.scrollIntoViewIfNeeded({ timeout: 3000 }));
    } catch {}
    let clicked = false;
    let clickErr = null;
    accept = true;
    for (const attempt of [
      () => el.click({ timeout: 5000 }),
      () => el.click({ force: true, timeout: 3000 }),
      () =>
        typeof el.dispatchEvent === 'function'
          ? el.dispatchEvent('click')
          : Promise.reject(new Error('no dispatchEvent')),
    ]) {
      try {
        await attempt();
        clicked = true;
        break;
      } catch (e) {
        clickErr = e;
      }
    }
    const cleanupWaiters = () => {
      settled = true;
      if (dlListener && typeof page.off === 'function') {
        try {
          page.off('download', dlListener);
        } catch {}
      }
      if (respListener && typeof page.off === 'function') {
        try {
          page.off('response', respListener);
        } catch {}
      }
      if (pageListener && ctx) {
        try {
          if (typeof ctx.off === 'function') ctx.off('page', pageListener);
          else if (typeof ctx.removeListener === 'function') ctx.removeListener('page', pageListener);
        } catch {}
      }
      // Вкладки из буфера, не ставшие победителем, закрываем — они
      // пойманы в окно нашего клика.
      while (pageEvents.length) {
        const p = pageEvents.shift();
        try {
          if (p && p.close) p.close();
        } catch {}
      }
    };
    if (!clicked) {
      cleanupWaiters();
      skipNote(candName, String((clickErr && clickErr.message) || clickErr || 'click failed'));
      return;
    }

    // Дедлайн гонки — после успешного клика: бюджет на скролл и ретраи
    // клика из него не вычитается (ревью PLUG-376).
    const deadline = Date.now() + CLICK_WAIT_MS;

    // Новая вкладка: window.open стартует с about:blank, waitForLoadState
    // резолвится до навигации — ждём реальный http(s) URL, параллельно
    // гоним download-ивент вкладки; пустой/чужой URL — не победа.
    const inspectNewPage = async (p) => {
      const until = Math.min(deadline, Date.now() + 6000);
      const urlP = (async () => {
        while (!settled && Date.now() < until) {
          let u = '';
          try {
            u = (p.url && p.url()) || '';
          } catch {}
          if (u && /^https?:/i.test(u)) return u;
          try {
            await (p.waitForLoadState &&
              p.waitForLoadState('domcontentloaded', {
                timeout: Math.min(1500, Math.max(1, until - Date.now())),
              }));
          } catch {}
          await sleep(120);
        }
        return null;
      })();
      const dlP =
        typeof p.waitForEvent === 'function'
          ? p
              .waitForEvent('download', { timeout: Math.max(1, until - Date.now()) })
              .then((dl) => ({ dl }))
              .catch(() => null)
          : Promise.resolve(null);
      // Берём первый НЕ-пустой результат — ошибка одного канала не
      // обгоняет другой (about:blank urlP vs dlP).
      let decided = false;
      const first = await new Promise((resolve) => {
        let left = 2;
        const take = (v) => {
          if (decided) return;
          if (v) {
            decided = true;
            resolve(v);
            return;
          }
          if (--left === 0) resolve(null);
        };
        urlP.then(take, () => take(null));
        dlP.then(take, () => take(null));
      });
      if (settled || !first) {
        try {
          await (p.close && p.close());
        } catch {}
        return null;
      }
      if (first.dl) return { kind: 'download', dl: first.dl, page: p };
      const cls = classifyDlUrl(first);
      if (cls === 'allowed' || cls === 'drive') {
        return { kind: 'page', page: p, url: first };
      }
      try {
        await (p.close && p.close());
      } catch {}
      return null;
    };

    const waiters = [];
    // 1) Нативное download-событие: буфер слушателя с момента клика
    // (или прямой waitForEvent, если page.on в среде недоступен).
    if (dlListener) {
      waiters.push(
        (async () => {
          while (!settled && Date.now() < deadline) {
            if (dlEvents.length) return { kind: 'download', dl: dlEvents[0] };
            await sleep(60);
          }
          return null;
        })()
      );
    } else if (typeof page.waitForEvent === 'function') {
      waiters.push(
        page
          .waitForEvent('download', { timeout: Math.max(1, deadline - Date.now()) })
          .then((dl) => ({ kind: 'download', dl }))
          .catch(() => null)
      );
    }
    // 2) Новые вкладки контекста из буфера — экспорт открывает viewer/файл
    // в новой странице; URL забираем и стягиваем через request-контекст.
    if (pageListener) {
      waiters.push(
        (async () => {
          const seenPages = new Set();
          while (!settled && Date.now() < deadline) {
            while (pageEvents.length) {
              const p = pageEvents.shift();
              if (seenPages.has(p)) continue;
              seenPages.add(p);
              const r = await inspectNewPage(p);
              if (r) return r;
            }
            await sleep(80);
          }
          return null;
        })()
      );
    }
    // 3) Сетевой ответ-файл из буфера (валидность проверена в слушателе).
    if (respListener) {
      waiters.push(
        (async () => {
          while (!settled && Date.now() < deadline) {
            if (respEvents.length) return { kind: 'response', ...respEvents[0] };
            await sleep(60);
          }
          return null;
        })()
      );
    }
    // 4) fetch→blob: опрос blob-URL, записанных хуком после клика.
    waiters.push(
      (async () => {
        while (!settled && Date.now() < deadline) {
          try {
            const list = await page.evaluate(
              ({ since }) =>
                Array.isArray(window.__argonDlBlobs)
                  ? window.__argonDlBlobs
                      .filter((e) => e && e.url && e.ts >= since)
                      .map((e) => ({ url: e.url, type: e.type, ts: e.ts }))
                  : [],
              { since: clickStart - 500 }
            );
            const hit = (list || []).find((e) => typeof e.url === 'string' && e.url.startsWith('blob:'));
            if (hit) return { kind: 'blob', entry: hit };
          } catch {
            return null;
          }
          await sleep(200);
        }
        return null;
      })()
    );

    const winner = await firstNonNull(waiters);
    cleanupWaiters();

    try {
      if (!winner) {
        skipNote(candName, 'download did not materialize');
      } else if (winner.kind === 'download') {
        const dl = winner.dl;
        // У click-кандидатов href в DOM не было — хост download-события
        // сверяем с белым списком здесь (ревью PLUG-291). Хост не
        // определён (data:, blob без origin) — пропускаем проверку.
        let dlHost = null;
        try {
          const u = dl.url && dl.url();
          dlHost = u ? downloadUrlHost(u) : null;
        } catch {}
        if (dlHost && DRIVE_GATE_HOST_RE.test(dlHost)) {
          skipNote(candName, 'requires Google Drive integration');
        } else if (dlHost && !isAllowedDownloadHost(dlHost)) {
          skipNote(candName, `host not allowed (${dlHost})`);
        } else {
          const name = sanitizeDownloadName(
            (dl.suggestedFilename && dl.suggestedFilename()) || candName || 'file'
          );
          const dest = destFor(name);
          await dl.saveAs(`${dest}.part`);
          let st;
          try {
            st = fs.statSync(`${dest}.part`);
          } catch {
            skipNote(name, 'download did not materialize');
            return;
          }
          if (st.size > maxBytes) {
            try {
              fs.unlinkSync(`${dest}.part`);
            } catch {}
            skipNote(name, `too large (${st.size} bytes > ${maxBytes})`);
            return;
          }
          fs.renameSync(`${dest}.part`, dest);
          files.push({ path: dest, name, mimeType: mimeFromName(name), sizeBytes: st.size });
        }
      } else if (winner.kind === 'page') {
        const p = winner.page;
        try {
          // URL и хост уже завалидированы в inspectNewPage (allowed|drive).
          if (classifyDlUrl(winner.url) === 'drive') {
            skipNote(candName, 'requires Google Drive integration');
          } else {
            await fetchUrlToFile(winner.url, candName);
          }
        } finally {
          try {
            await (p.close && p.close());
          } catch {}
        }
      } else if (winner.kind === 'response') {
        const resp = winner.resp;
        // Хост ответа уже проверен в слушателе (allowed|drive, 2xx).
        if (classifyDlUrl(winner.url) === 'drive') {
          skipNote(candName, 'requires Google Drive integration');
        } else {
          let body = null;
          let headers = {};
          try {
            headers = (resp.headers && resp.headers()) || {};
            body = await resp.body();
          } catch {}
          if (body && body.length) {
            saveBufferToFile(
              nameForFetched(headers, winner.url, candName),
              headers['content-type'],
              body
            );
          } else if (winner.url) {
            await fetchUrlToFile(winner.url, candName);
          } else {
            skipNote(candName, 'download did not materialize');
          }
        }
      } else if (winner.kind === 'blob') {
        const entry = winner.entry;
        const host = downloadUrlHost(entry.url);
        if (host && !isAllowedDownloadHost(host)) {
          skipNote(candName, `host not allowed (${host})`);
        } else {
          // Байты читаем из сохранённого Blob — переживает revokeObjectURL;
          // запасной путь — fetch(blob: URL) по старой схеме (ревью PLUG-376).
          const data = await page
            .evaluate(async ({ url, lim }) => {
              try {
                let buf = null;
                let mime = '';
                const rec = (window.__argonDlBlobs || []).find((e) => e && e.url === url);
                const blob = rec && rec.blob;
                if (blob && typeof blob.arrayBuffer === 'function') {
                  if ((blob.size || 0) > lim) return { tooLarge: blob.size };
                  mime = blob.type || '';
                  buf = await blob.arrayBuffer();
                } else {
                  const r = await fetch(url);
                  const cl = Number((r.headers && r.headers.get('content-length')) || 0);
                  if (cl > lim) return { tooLarge: cl };
                  mime = (r.headers && r.headers.get('content-type')) || '';
                  buf = await r.arrayBuffer();
                }
                if (!buf || buf.byteLength > lim) {
                  return { tooLarge: buf ? buf.byteLength : 0 };
                }
                const bytes = new Uint8Array(buf);
                let s = '';
                for (let i = 0; i < bytes.length; i += 0x8000) {
                  s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                }
                return { b64: btoa(s), mime };
              } catch {
                return null;
              }
            }, { url: entry.url, lim: maxBytes })
            .catch(() => null);
          if (data && data.tooLarge != null) {
            skipNote(candName, `too large (${data.tooLarge} bytes > ${maxBytes})`);
          } else if (data && data.b64) {
            const body = Buffer.from(data.b64, 'base64');
            saveBufferToFile(candName, data.mime || entry.type, body);
          } else {
            skipNote(candName, 'blob fetch failed');
          }
        }
      }
    } catch (e) {
      skipNote(candName, String((e && e.message) || e));
    } finally {
      // Вкладка, отдавшая download-ивент, тоже закрывается.
      if (winner && winner.page && typeof winner.page.close === 'function') {
        try {
          await winner.page.close();
        } catch {}
      }
    }
  };

  for (const c of cands) {
    if (files.length >= maxCount) {
      skipNote(c.name || c.href || 'file', `count limit (${maxCount})`);
      continue;
    }
    if (opts.throwIfCancelled) {
      try {
        await opts.throwIfCancelled();
      } catch {
        return { files, skipped };
      }
    }
    if (tries >= attemptBudget) {
      skipNote(c.name || c.href || 'file', `attempt budget (${attemptBudget})`);
      continue;
    }
    tries += 1;
    if (c.kind === 'link') {
      const linkName = c.name || nameFromUrl(c.href) || 'file';
      const hrefCls = classifyDlUrl(c.href);
      // Белый список DOM-скана пропускает *.google.com — ссылку на
      // Docs/Drive viewer нельзя стягивать как файл (ревью PLUG-376).
      if (hrefCls === 'drive') {
        skipNote(linkName, 'requires Google Drive integration');
      } else if (hrefCls !== 'allowed') {
        skipNote(linkName, `host not allowed (${dlHostNote(c.href)})`);
      } else {
        try {
          const ctx = page.context && page.context();
          const req = ctx && ctx.request;
          if (!req) throw new Error('no request context');
          const resp = await req.get(c.href, { timeout: 15000 });
          // req.get идёт по редиректам — финальный хост проверяем тоже.
          const finalUrl = (typeof resp.url === 'function' && resp.url()) || c.href;
          const fCls = classifyDlUrl(finalUrl);
          if (fCls === 'drive') {
            skipNote(linkName, 'requires Google Drive integration');
          } else if (fCls !== 'allowed') {
            skipNote(linkName, `host not allowed (${dlHostNote(finalUrl)})`);
          } else if (!resp.ok()) {
            if (c.canClick) {
              await tryDownloadByClick(c);
            } else {
              skipNote(linkName, `http ${resp.status()}`);
            }
          } else {
            const headers = resp.headers();
            const cl = Number(headers['content-length'] || 0);
            if (cl > maxBytes) {
              skipNote(linkName, `too large (${cl} bytes > ${maxBytes})`);
            } else {
              const body = await resp.body();
              if (body.length > maxBytes) {
                skipNote(linkName, `too large (${body.length} bytes > ${maxBytes})`);
              } else {
                const name = sanitizeDownloadName(
                  fileNameFromDisposition(headers['content-disposition']) ||
                    c.name ||
                    nameFromUrl(finalUrl) ||
                    'file'
                );
                const dest = destFor(name);
                const tmp = `${dest}.part`;
                fs.writeFileSync(tmp, body);
                fs.renameSync(tmp, dest);
                files.push({
                  path: dest,
                  name,
                  mimeType: String(headers['content-type'] || '').split(';')[0].trim() || mimeFromName(name),
                  sizeBytes: body.length,
                });
              }
            }
          }
        } catch (e) {
          if (c.canClick) {
            await tryDownloadByClick(c);
          } else {
            skipNote(linkName, String((e && e.message) || e));
          }
        }
      }
    } else {
      await tryDownloadByClick(c);
    }
  }
  return { files, skipped };
}

async function downloadGeneratedMedia(page, targetPath) {
  const fs = require('fs');
  const path = require('path');
  const resolvedTarget = path.resolve(targetPath);

  await page.waitForTimeout(1000);

  // 1. Check for rendered image in latest response via canvas toDataURL
  const imgDataUrl = await safeEval(page, () => {
    const lastResp = document.querySelector('model-response:last-of-type');
    if (!lastResp) return null;
    const img = lastResp.querySelector(
      'generated-image img, img.image, .image-container img, img[src*="blob:"], img[src*="googleusercontent"], img'
    );
    if (!img) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width || 1024;
      canvas.height = img.naturalHeight || img.height || 1024;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (e) {
      return null;
    }
  });

  if (imgDataUrl && imgDataUrl.startsWith('data:image/')) {
    let dest = resolvedTarget;
    if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()) {
      dest = path.join(resolvedTarget, `gemini-image-${Date.now()}.png`);
    } else if (!path.extname(dest)) {
      dest = `${dest}.png`;
    }
    const base64 = imgDataUrl.split(',')[1];
    fs.writeFileSync(dest, Buffer.from(base64, 'base64'));
    return dest;
  }

  // 2. Check for download button on latest response
  const downloadBtn = await safeQuery(page,
    'model-response:last-of-type button[aria-label*="Download" i], model-response:last-of-type a[download], [data-test-id*="download"]'
  );

  if (downloadBtn) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 8000 }),
        downloadBtn.click()
      ]);
      let dest = resolvedTarget;
      if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()) {
        dest = path.join(resolvedTarget, download.suggestedFilename() || 'gemini-media');
      }
      await download.saveAs(dest);
      return dest;
    } catch {}
  }

  // 3. Check for generated image in latest response with data: URI
  const imgData = await safeEval(page, () => {
    const lastResp = document.querySelector('model-response:last-of-type');
    if (!lastResp) return null;
    const img = lastResp.querySelector(
      'generated-image img, img[src*="googleusercontent"], img[src*="blob:"], .image-container img'
    );
    if (!img) return null;
    return { src: img.src, alt: img.alt || '' };
  });

  if (imgData && imgData.src) {
    let dest = resolvedTarget;
    if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()) {
      dest = path.join(resolvedTarget, `gemini-media-${Date.now()}.png`);
    } else if (!path.extname(dest)) {
      dest = `${dest}.png`;
    }

    if (imgData.src.startsWith('data:')) {
      const base64 = imgData.src.split(',')[1];
      fs.writeFileSync(dest, Buffer.from(base64, 'base64'));
      return dest;
    }
  }

  return null;
}

async function getBrowserStatus(opts = {}) {
  const cdpUp = await isCdpReady();
  const runningMode = getRunningChromeMode();
  const runningProfile = getRunningChromeProfile();
  const activeProfile = profileManager.getActiveProfile();

  if (!cdpUp) {
    return {
      connected: false,
      mode: null,
      runningProfile: null,
      activeProfile,
      tabs: []
    };
  }

  const playwright = getPlaywright();
  const browser = await playwright.chromium.connectOverCDP(cdpUrl());
  const tabs = [];

  try {
    for (const ctx of browser.contexts()) {
      for (const [idx, page] of ctx.pages().entries()) {
        const title = await page.title().catch(() => 'Untitled');
        tabs.push({
          index: idx + 1,
          title: title.trim(),
          url: page.url()
        });
      }
    }
  } finally {
    await browser.close();
  }

  return {
    connected: true,
    mode: runningMode || 'visible',
    runningProfile,
    activeProfile,
    tabs
  };
}

module.exports = {
  getPlaywright,
  setCdpPort,
  ModelUnavailable,
  RESET_REGEX_EXTENDED,
  selectModelAndThinking,
  menuItemHasLockIcon,
  upsellDialogConfirmsLock,
  markVisibleDialogs,
  stopGeneration,
  findTurnTarget,
  checkTurnStatus,
  isTurnComplete,
  waitForHistoryStabilization,
  fileResponseHistory,
  captureFileResponse,
  getGeminiPage,
  checkRobotVerification,
  dismissOverlays,
  sendPrompt,
  ensureChrome,
  stopChrome,
  isCdpReady,
  getRunningChromeMode,
  getRunningChromeProfile,
  getBrowserStatus,
  getUploadToolsButton,
  attachFile,
  collectGeneratedFiles,
  findGeneratedFileCandidates,
  sanitizeDownloadName,
  isAllowedDownloadHost,
  downloadUrlHost,
  downloadGeneratedMedia,
  listConversations,
  listConversationsInternal,
  getConversationTranscript,
  deleteConversation,
  deleteConversationInternal,
  captureUsageLimits: usageLimits.captureUsageLimits,
  parseUsageLimits: usageLimits.parseUsageLimits,
  extractWrbFrames: usageLimits.extractWrbFrames,
  findMetricRecords: usageLimits.findMetricRecords,
  readAccountsUsage: usageLimits.readAccountsUsage,
  updateAccountUsage: usageLimits.updateAccountUsage,
  usageLimits,
  profileManager,
  _setDriverHooks
};
