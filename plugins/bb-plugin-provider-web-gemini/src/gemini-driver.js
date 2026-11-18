const path = require('path');
const fs = require('fs');
const os = require('os');
const profileManager = require('./profile-manager');
const usageLimits = require('./usage-limits');

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
    throw err;
  }
}

// PLUG-282: exact lock-badge predicate. The old substring check
// `className.includes('lock')` false-positived on 'unlock', 'lock_open',
// 'mat-icon-lock-reset' etc. A real lock badge is a *visible* icon whose
// Material identity is exactly 'lock'. Self-contained so Playwright can
// serialize it into the page and unit tests can call it on a fake DOM.
// PLUG-324: check data-mode-id attribute for upsell markers (e.g. upsell_MODE_CATEGORY_ULTRA).
function menuItemHasLockIcon(el) {
  if (!el) return false;
  const rawModeId =
    (typeof el.getAttribute === 'function' ? el.getAttribute('data-mode-id') : null) ||
    (el.dataset && el.dataset.modeId) ||
    (typeof el.querySelector === 'function' ? el.querySelector('[data-mode-id]')?.getAttribute('data-mode-id') : null) ||
    (typeof el.closest === 'function' ? el.closest('[data-mode-id]')?.getAttribute('data-mode-id') : null) ||
    '';
  const modeId = String(rawModeId).trim().toLowerCase();
  if (modeId.startsWith('upsell_') || modeId.startsWith('upsell') || modeId.includes('upsell')) return true;

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
        argon: ['argon', 'neon', 'deeper analysis', 'глубокий анализ', 'код и анализ'],
        neon: ['neon', 'deeper analysis', 'глубокий анализ', 'argon', 'код и анализ'],
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
  { intervalMs = 350, ceilingMs = 10000, throwIfCancelled = null } = {}
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
      if (stableMeasurements >= 2) {
        return current;
      }
    } else {
      stableMeasurements = 0;
      prevCount = current;
    }
  }
  return (await safeQueryAll(page, 'model-response')).length;
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
  stateDir = null
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
    let downloadedPath = null;
    let generatedFiles = [];
    let skippedDownloads = [];

    // PLUG-291: пользовательские файлы прикладываются веб-вложениями до
    // вставки текста/хода — в т.ч. на хуковом пути runTurn (тесты).
    const uploadList = Array.isArray(files) ? files : (file ? [file] : []);
    const attachFn = driverHooks && driverHooks.attachFile ? driverHooks.attachFile : attachFile;

    if (driverHooks?.runTurn) {
      for (const f of uploadList) {
        await attachFn(page, f);
      }
      const turnRes = await driverHooks.runTurn(page);
      lastText = turnRes.text || '';
      returnedConvId = turnRes.convId || convId;
      downloadedPath = turnRes.downloaded || null;
      generatedFiles = turnRes.files || [];
      skippedDownloads = turnRes.skippedDownloads || [];
    } else {
    if (page.url() === 'about:blank' || (convId && !page.url().includes(convId))) {
      const targetUrl = convId ? `https://gemini.google.com/app/${convId}` : GEMINI_APP_URL;
      await page.goto(targetUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
    } else if (isNewChat) {
      // The side-nav "new chat" button is frequently covered by overlays and
      // stalls the click for its full timeout — a plain goto is reliable.
      await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded' });
    }

    await dismissOverlays(page);
    await throwIfCancelled();

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

    for (const f of uploadList) {
      await attachFn(page, f);
    }

    const initialCount = await waitForHistoryStabilization(page, convId, { throwIfCancelled });

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
          ({ sel, want }) => {
            const t = (((document.querySelector(sel) || {}).innerText) || '')
              .replace(/\s+/g, ' ').trim();
            return want === '' ? t.length > 0 : t.startsWith(want);
          },
          { sel: textboxSelector, want: wantStart }
        );
        if (!typed) typeErr = new Error('prompt text did not reach the editor');
      } catch (e) {
        typeErr = e;
        await page.waitForTimeout(500);
      }
    }
    if (!typed) throw typeErr;
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

    if (downloadsDir) {
      // PLUG-291: файлы, сгенерированные в ответе, скачиваются post-turn —
      // пока DOM текущего ответа ещё жив (до ephemeral-удаления и парковки).
      const coll = await collectGeneratedFiles(page, {
        dir: downloadsDir,
        sessionId: sessionId || returnedConvId || 'dl',
        turnIndex: initialCount,
        promptPrefix,
        throwIfCancelled,
      }).catch((err) => {
        console.warn('[gemini] collectGeneratedFiles error:', err && err.message);
        return { files: [], skipped: [] };
      });
      generatedFiles = coll.files || [];
      skippedDownloads = coll.skipped || [];
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
    resObj.thinking = null;
    resObj.meta = {};
    resObj.convId = returnedConvId;
    resObj.downloaded = downloadedPath;
    resObj.files = generatedFiles;
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

async function attachFile(page, filePath) {
  const fs = require('fs');
  const path = require('path');
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File to attach not found: ${filePath}`);
  }

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
 * повторно. Два канала: прямые download-URL белого списка доменов через
 * context.request и кнопки Download/Export через download-событие (клик).
 * Ссылки вне белого списка не кликаются и не выгружаются.
 */
async function collectGeneratedFiles(page, opts = {}) {
  const dir = opts.dir;
  const files = [];
  const skipped = [];
  if (!dir || !page) return { files, skipped };
  const maxCount = numEnv(['WEB_GEMINI_MAX_DOWNLOAD_COUNT', 'ARGON_MAX_DOWNLOAD_COUNT'], 5);
  const maxBytes = numEnv(['WEB_GEMINI_MAX_DOWNLOAD_BYTES', 'ARGON_MAX_DOWNLOAD_BYTES'], 50 * 1024 * 1024);
  const nonce = `n${Date.now().toString(36)}`;

  let cands = null;
  try {
    cands = await safeEval(
      page,
      ({ idx, promptPrefix, fnSrc, tagAttr }) => {
        if (!window.__argonFindTurnTarget && fnSrc) {
          window.__argonFindTurnTarget = (0, eval)('(' + fnSrc + ')');
        }
        const fn = window.__argonFindTurnTarget;
        const target = fn ? fn(document, idx, promptPrefix) : null;
        if (!target) return [];
        const FILE_EXT_RE =
          /\.(pdf|pptx?|xlsx?|docx?|csv|tsv|md|txt|zip|json|png|jpe?g|gif|svg|webp|mp3|wav|mp4|html?|ics|epub)(?:$|[?#])/i;
        const okHost = (u) => {
          try {
            const h = new URL(u, location.href).hostname.toLowerCase();
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
        let seq = 0;
        for (const a of target.querySelectorAll('a[href]')) {
          const href = a.href || a.getAttribute('href') || '';
          if (!href || seen.has(href)) continue;
          if (!okHost(href)) continue;
          const hasDl = a.hasAttribute('download');
          const label = ((a.getAttribute('aria-label') || '') + ' ' + (a.innerText || '')).trim();
          const dlText = /download|скачать|export|экспорт/i.test(label);
          if (!hasDl && !dlText && !FILE_EXT_RE.test(href)) continue;
          seen.add(href);
          const tag = `${tagAttr}-${seq++}`;
          a.setAttribute('data-argon-dl', tag);
          out.push({
            kind: 'link',
            tag,
            href,
            name: (a.getAttribute('download') || label || '').slice(0, 120),
            canClick: hasDl,
          });
        }
        for (const b of target.querySelectorAll('button, [role="button"], a:not([href])')) {
          const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim();
          if (!/download|скачать|export|экспорт/i.test(label)) continue;
          const tag = `${tagAttr}-${seq++}`;
          b.setAttribute('data-argon-dl', tag);
          out.push({ kind: 'click', tag, name: label.slice(0, 120) });
        }
        return out;
      },
      { idx: opts.turnIndex ?? 0, promptPrefix: opts.promptPrefix || '', fnSrc: findTurnTarget.toString(), tagAttr: nonce }
    );
  } catch {
    return { files, skipped };
  }

  if (!Array.isArray(cands) || !cands.length) return { files, skipped };

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

  const tryDownloadByClick = async (c, fallbackName) => {
    const el = await safeQuery(page, `[data-argon-dl="${c.tag}"]`);
    if (!el) {
      skipNote(fallbackName || c.name || 'download', 'element gone');
      return;
    }
    try {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        el.click({ timeout: 5000 }),
      ]);
      // У click-кандидатов href в DOM не было — хост download-события
      // сверяем с белым списком здесь (ревью PLUG-291). Хост не
      // определён (data:, blob без origin) — пропускаем проверку.
      let dlHost = null;
      try {
        const u = dl.url && dl.url();
        dlHost = u ? downloadUrlHost(u) : null;
      } catch {}
      if (dlHost && !isAllowedDownloadHost(dlHost)) {
        skipNote(fallbackName || c.name || 'download', `host not allowed (${dlHost})`);
        return;
      }
      const name = sanitizeDownloadName(
        (dl.suggestedFilename && dl.suggestedFilename()) || fallbackName || c.name || 'file'
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
    } catch (e) {
      skipNote(fallbackName || c.name || 'download', String((e && e.message) || e));
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
      let done = false;
      try {
        const ctx = page.context && page.context();
        const req = ctx && ctx.request;
        if (!req) throw new Error('no request context');
        const resp = await req.get(c.href, { timeout: 15000 });
        if (!resp.ok()) {
          if (c.canClick) {
            await tryDownloadByClick(c);
          } else {
            skipNote(c.name || nameFromUrl(c.href) || 'file', `http ${resp.status()}`);
          }
          done = true;
        } else {
          const headers = resp.headers();
          const cl = Number(headers['content-length'] || 0);
          if (cl > maxBytes) {
            skipNote(c.name || nameFromUrl(c.href) || 'file', `too large (${cl} bytes > ${maxBytes})`);
            done = true;
          } else {
            const body = await resp.body();
            if (body.length > maxBytes) {
              skipNote(c.name || nameFromUrl(c.href) || 'file', `too large (${body.length} bytes > ${maxBytes})`);
            } else {
              const name = sanitizeDownloadName(
                fileNameFromDisposition(headers['content-disposition']) ||
                  c.name ||
                  nameFromUrl(c.href) ||
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
            done = true;
          }
        }
      } catch (e) {
        if (c.canClick) {
          await tryDownloadByClick(c);
        } else {
          skipNote(c.name || nameFromUrl(c.href) || 'file', String((e && e.message) || e));
        }
        done = true;
      }
      void done;
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
