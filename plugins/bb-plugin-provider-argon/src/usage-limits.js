const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_RECIPE = {
  rpcid: 'jSf9Qc',
  args: '[]',
  updatedAt: 0,
};

const lastCaptureMap = new Map();

function withUsageLock(lockFile, fn) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
      fs.closeSync(fd);
      try {
        return fn();
      } finally {
        try { fs.unlinkSync(lockFile); } catch {}
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > 5000) {
          try { fs.unlinkSync(lockFile); } catch {}
          continue;
        }
      } catch {}
      const start = Date.now();
      while (Date.now() - start < 30) {}
    }
  }
  throw new Error(`usage lock held for over 10s: ${lockFile}`);
}

function extractWrbFrames(rawText) {
  const frames = [];
  if (!rawText || typeof rawText !== 'string') return frames;
  const text = rawText.replace(/^\)]}'\s*/, '');

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[[') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (Array.isArray(item) && item[0] === 'wrb.fr') {
              frames.push(item);
            }
          }
        }
      } catch {}
    }
  }
  if (frames.length > 0) return frames;

  let cursor = 0;
  while (cursor < text.length) {
    const nl = text.indexOf('\n', cursor);
    if (nl === -1) break;
    const lenStr = text.slice(cursor, nl).trim();
    const chunkLen = parseInt(lenStr, 10);
    if (!isNaN(chunkLen) && chunkLen > 0) {
      const chunkStart = nl + 1;
      const chunkEnd = chunkStart + chunkLen;
      const chunk = text.slice(chunkStart, chunkEnd);
      try {
        const parsed = JSON.parse(chunk);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (Array.isArray(item) && item[0] === 'wrb.fr') {
              frames.push(item);
            }
          }
        }
      } catch {}
      cursor = chunkEnd;
      while (cursor < text.length && (text[cursor] === '\r' || text[cursor] === '\n')) {
        cursor++;
      }
    } else {
      cursor = nl + 1;
    }
  }

  return frames;
}

function findMetricRecords(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    if (
      node.length >= 4 &&
      typeof node[1] === 'number' &&
      node[1] >= 0 &&
      node[1] <= 1.5 &&
      (node[2] === 1 || node[2] === 2) &&
      Array.isArray(node[3]) &&
      Array.isArray(node[3][0]) &&
      Number(node[3][0][0]) >= 1.6e9
    ) {
      found.push(node);
      return found;
    }
    for (const item of node) {
      findMetricRecords(item, found);
    }
  } else {
    for (const val of Object.values(node)) {
      findMetricRecords(val, found);
    }
  }
  return found;
}

function parseUsageLimits(rawText) {
  const frames = extractWrbFrames(rawText);
  if (!frames || frames.length === 0) return null;

  for (const frame of frames) {
    const rpcid = frame[1];
    let payload = null;
    if (typeof frame[2] === 'string') {
      try {
        payload = JSON.parse(frame[2]);
      } catch {
        continue;
      }
    } else if (typeof frame[2] === 'object' && frame[2] !== null) {
      payload = frame[2];
    } else {
      continue;
    }

    const records = findMetricRecords(payload);
    if (!records || records.length === 0) continue;

    let daily = null;
    let weekly = null;
    for (const m of records) {
      const ratio = m[1];
      const period = m[2];
      const resetEpochSec = Math.floor(Number(m[3][0][0]));
      const percent = Math.round(ratio * 100);
      const metric = { percent, resetEpochSec };
      if (period === 1) daily = metric;
      else if (period === 2) weekly = metric;
    }

    if (daily || weekly) {
      return {
        daily,
        weekly,
        workingRpcid: rpcid || DEFAULT_RECIPE.rpcid,
      };
    }
  }

  return null;
}

function readAccountsUsage(stateDir) {
  const file = path.join(stateDir, 'accounts-usage.json');
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          accounts: parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {},
          recipe: parsed.recipe && typeof parsed.recipe === 'object' ? parsed.recipe : { ...DEFAULT_RECIPE },
        };
      }
    }
  } catch {}
  return { accounts: {}, recipe: { ...DEFAULT_RECIPE } };
}

function updateAccountUsage(stateDir, accountId, usage, recipe) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'accounts-usage.json');
  const lock = path.join(stateDir, 'accounts-usage.json.lock');

  return withUsageLock(lock, () => {
    let data = { accounts: {}, recipe: { ...DEFAULT_RECIPE } };
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && typeof raw === 'object') {
          data.accounts = raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
          data.recipe = raw.recipe && typeof raw.recipe === 'object' ? raw.recipe : { ...DEFAULT_RECIPE };
        }
      }
    } catch {}

    const now = Date.now();
    data.accounts[accountId] = {
      daily: usage.daily || null,
      weekly: usage.weekly || null,
      tier: (usage.tier && String(usage.tier).toLowerCase().includes('ultra')) ? 'ultra' : 'pro',
      updatedAt: now,
      stale: false,
    };

    if (recipe && recipe.rpcid) {
      if (!data.recipe || data.recipe.rpcid !== recipe.rpcid) {
        data.recipe = {
          rpcid: recipe.rpcid,
          args: recipe.args || '[]',
          updatedAt: now,
        };
      }
    }

    const tmp = `${file}.${process.pid}.${now}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return data;
  });
}

async function captureUsageLimits(page, opts = {}) {
  if (!page || typeof page.evaluate !== 'function') return null;

  try {
    const url = page.url ? page.url() : '';
    if (!url.includes('gemini.google.com')) {
      return null;
    }
  } catch {
    return null;
  }

  const accountId = opts.accountId || opts.account || opts.profile || 'default';
  const stateDir = opts.stateDir || process.env.ARGON_STATE_DIR || path.join(os.homedir(), '.bb', 'plugins', 'provider-argon');
  const refreshMs = Number(process.env.ARGON_USAGE_REFRESH_MS ?? 300_000);

  if (!opts.force && refreshMs > 0) {
    const inMemLast = lastCaptureMap.get(accountId) || 0;
    if (Date.now() - inMemLast < refreshMs) {
      return null;
    }
    const onDisk = readAccountsUsage(stateDir);
    const diskLast = onDisk.accounts?.[accountId]?.updatedAt || 0;
    if (Date.now() - diskLast < refreshMs) {
      lastCaptureMap.set(accountId, diskLast);
      return null;
    }
  }

  const currentUsage = readAccountsUsage(stateDir);
  const rpcid = currentUsage.recipe?.rpcid || DEFAULT_RECIPE.rpcid;
  const args = currentUsage.recipe?.args || DEFAULT_RECIPE.args;

  let evalRes;
  try {
    evalRes = await page.evaluate(async ({ rpcid, args }) => {
      try {
        const wiz = window.WIZ_global_data || {};
        const at = wiz.SNlM0e;
        const bl = wiz.cfb2h || '';
        const fsid = wiz.FdrFJe || '';
        if (!at) {
          return { error: 'Missing SNlM0e at-token in window.WIZ_global_data' };
        }
        const reqid = Math.floor(100000 + Math.random() * 900000);
        const params = new URLSearchParams({
          rpcids: rpcid,
          'source-path': '/usage',
          bl: bl,
          'f.sid': fsid,
          hl: 'en',
          _reqid: String(reqid),
          rt: 'c',
        });
        const url = `/_/BardChatUi/data/batchexecute?${params.toString()}`;
        const reqPayload = [[[rpcid, args, null, 'generic']]];
        const body = `f.req=${encodeURIComponent(JSON.stringify(reqPayload))}&at=${encodeURIComponent(at)}`;

        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
          credentials: 'include',
          body: body,
        });

        if (!resp.ok) {
          return { error: `batchexecute status ${resp.status}` };
        }
        const text = await resp.text();

        let domTier = null;
        try {
          const bodyText = document.body ? document.body.innerText : '';
          if (/gemini ultra|gemini advanced/i.test(bodyText) || document.querySelector('[aria-label*="Advanced" i], [aria-label*="Ultra" i]')) {
            domTier = 'ultra';
          } else if (/gemini pro/i.test(bodyText) || document.querySelector('[aria-label*="Pro" i]')) {
            domTier = 'pro';
          }
        } catch {}

        return { text, domTier };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    }, { rpcid, args });
  } catch (err) {
    if (process.env.ARGON_DEBUG) {
      console.warn('[argon] Runtime.evaluate failed during captureUsageLimits:', err.message);
    }
    return null;
  }

  if (!evalRes || evalRes.error) {
    if (process.env.ARGON_DEBUG) {
      console.warn('[argon] captureUsageLimits evaluate error:', evalRes ? evalRes.error : 'empty response');
    }
    return null;
  }

  const parsed = parseUsageLimits(evalRes.text);
  if (!parsed || (!parsed.daily && !parsed.weekly)) {
    if (process.env.ARGON_DEBUG) {
      console.warn('[argon] captureUsageLimits: no metric records found in batchexecute response');
    }
    return null;
  }

  const rawTier = opts.tier || (opts.backend && opts.backend.tier) || evalRes.domTier || 'pro';
  const tier = String(rawTier).toLowerCase().includes('ultra') ? 'ultra' : 'pro';

  try {
    const updated = updateAccountUsage(
      stateDir,
      accountId,
      { daily: parsed.daily, weekly: parsed.weekly, tier },
      { rpcid: parsed.workingRpcid, args }
    );
    lastCaptureMap.set(accountId, Date.now());
    return updated;
  } catch (err) {
    if (process.env.ARGON_DEBUG) {
      console.warn('[argon] updateAccountUsage failed:', err.message);
    }
    return null;
  }
}

module.exports = {
  DEFAULT_RECIPE,
  extractWrbFrames,
  findMetricRecords,
  parseUsageLimits,
  readAccountsUsage,
  updateAccountUsage,
  captureUsageLimits,
  _lastCaptureMap: lastCaptureMap,
};
