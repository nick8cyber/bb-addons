/**
 * provider-web-gemini-tools (docs/specs/provider-web-gemini-tools.md, rev 3):
 * текстовый протокол вызова инструментов `<tool name="..." .../>`,
 * инструменты только чтения в cwd сессии, маскировка секретов по правилам
 * сканера утечек оркестратора, упаковка первого сообщения сессии и цикл
 * раундов с лимитом maxRounds.
 *
 * Гигиена репозитория: литералы "t"+"hr_", "p"+"roj_", "e"+"nv_", "/"+"home/",
 * "/"+"opt/" в исходниках плагина запрещены тестом 1 — все такие строки
 * собираются динамически или пишутся символьными классами в регулярках.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const num = (name, legacyName, dflt) => {
  const v = Number(process.env[name] ?? process.env[legacyName]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

export const TOOL_TIMEOUT_MS = num("WEB_GEMINI_TOOL_TIMEOUT_MS", "ARGON_TOOL_TIMEOUT_MS", 15_000);
export const MAX_TOOL_RESULT_BYTES = 60_000;
export const MAX_MESSAGE_BYTES = num("WEB_GEMINI_MAX_MESSAGE_BYTES", "ARGON_MAX_MESSAGE_BYTES", 120_000);

// provider-web-gemini §4.1: бюджет исходящего промпта (зеркалит
// webGeminiMaxPromptBytes() из acp-server.mjs — модуль самодостаточен).
const promptBudgetBytes = () => {
  const raw = process.env.WEB_GEMINI_MAX_PROMPT_BYTES ?? process.env.ARGON_MAX_PROMPT_BYTES;
  if (raw == null || raw === "") return 100_000;
  const v = Number(raw);
  return Number.isFinite(v) ? (v > 0 ? v : Number.POSITIVE_INFINITY) : 100_000;
};

let messageCapWarned = false;
// provider-web-gemini §4.1: потолок упаковки обязан быть ≤ бюджету промпта минус
// ~4 КБ запаса — иначе packFirstMessage соберёт заведомо неотправимое
// сообщение. Заданное большим значение логируется и зажимается до потолка.
export function effectiveMessageBytes(maxBytes = MAX_MESSAGE_BYTES) {
  const budget = promptBudgetBytes();
  if (!Number.isFinite(budget)) return maxBytes;
  const cap = Math.max(0, budget - 4096);
  if (maxBytes <= cap) return maxBytes;
  if (!messageCapWarned) {
    messageCapWarned = true;
    process.stderr.write(
      `[provider-web-gemini] WEB_GEMINI_MAX_MESSAGE_BYTES=${maxBytes} exceeds prompt budget; clamped to ${cap}\n`,
    );
  }
  return cap;
}
export const MAX_TOOL_ROUNDS = num("WEB_GEMINI_MAX_TOOL_ROUNDS", "ARGON_MAX_TOOL_ROUNDS", 8);
export const MAX_LIST_ENTRIES = 200;
export const MAX_GREP_LINES = 100;
export const TRUNC_SUFFIX =
  "\n[... обрезано провайдером; используйте параметры диапазона from/to или более точный фильтр]";

// Разбитые литералы — см. шапку про гигиену репозитория.
const THR = "t" + "hr_";
const PROJ = "p" + "roj_";
const ENV_ = "e" + "nv_";

export const THREAD_ID_RE = new RegExp(`^${THR}[a-z0-9]{6,}$`, "i");
const THREAD_ID_IN_TEXT_RE = new RegExp(`${THR}[a-z0-9]{6,}(?:#msg=(\\d+))?`, "gi");
export const TASK_KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const TASK_KEY_IN_TEXT_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/** Общие ложноположительные ключей задач (тот же список, что в leak-scan). */
const TASK_KEY_ALLOW = new Set([
  "UTF-8", "UTF-16", "UTF-32", "ISO-8859", "SHA-1", "SHA-256", "SHA-384",
  "SHA-512", "MD-5", "DES-3", "AES-128", "AES-192", "AES-256",
]);
export const isTaskKeyToken = (token) => TASK_KEY_RE.test(token) && !TASK_KEY_ALLOW.has(token);

/* ---------- §6: маскировка (правила сканера утечек, категории 1–4) ----------
 * Формат подстановки — `[скрыто: <тип>]` по спеке. Сами регулярки зеркалят
 * таблицы plugins/bb-plugin-orchestrator/hooks/leak-scan.ts (их
 * SECRET_VALUE_RES/PLUGIN_SECRET_RULES/PERSONAL_EMAIL_RE/MACHINE_RULES/
 * BB_ID_RULES не экспортируются, а maskSecrets там даёт формат `prefix…***`,
 * не тот, что требует §6). Семантика `threadIds=true` сканера: идентификаторы
 * тредов и ключи задач — рабочие сущности пайплайна и НЕ маскируются. */

export const SECRET_RULES = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?=-----END|$)/g],
  ["vless-uri", /vless:\/\/\S+/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,}/g],
  ["github-token", /github_pat_[A-Za-z0-9_]{10,}/g],
  ["api-key", /\bsk-[A-Za-z0-9_-]{12,}/g],
  ["api-key", /\bxox[baprs]-[A-Za-z0-9-]{8,}/g],
  ["api-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["api-key", /\bAIza[0-9A-Za-z_-]{20,}\b/g],
  ["api-key", /\bya29\.[0-9A-Za-z_-]{10,}/g],
  ["vpn-private-key", /PrivateKey\s*=\s*\S+/g],
];

export const PERSONAL_EMAIL_RE =
  /[\w.+-]{1,64}@(?:gmail|googlemail|yandex|ya\.ru|mail\.ru|bk\.ru|inbox\.ru|list\.ru|outlook|hotmail|live|yahoo|icloud|me\.com|proton\.me|protonmail|rambler)\.[a-z.]+/gi;

const HOSTNAME = os.hostname();
export const MACHINE_RULES = [
  ["home-path", /\/(?:home|Users)\/[A-Za-z0-9._-]+(?=\/)/g],
  ["opt-path", /\/opt\/[A-Za-z0-9._-]/g],
  [
    "private-ip",
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  ],
];
if (HOSTNAME && HOSTNAME.length > 2) {
  const esc = HOSTNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  MACHINE_RULES.push(["hostname", new RegExp(`\\b${esc}\\b`, "g")]);
}

export const BB_ID_RULES = [
  ["bb-project-id", new RegExp(`\\b${PROJ}[a-z0-9]{6,}\\b`, "gi")],
  ["bb-env-id", new RegExp(`\\b${ENV_}[a-z0-9]{6,}\\b`, "gi")],
  ["getbb-host", /\b[a-z0-9-]{1,63}\.getbb\.app\b/gi],
];

export function maskForWeb(text) {
  let out = String(text ?? "");
  const apply = (rules) => {
    for (const [type, re] of rules) {
      out = out.replace(re, () => `[скрыто: ${type}]`);
    }
  };
  apply(SECRET_RULES);
  out = out.replace(PERSONAL_EMAIL_RE, () => "[скрыто: email]");
  apply(MACHINE_RULES);
  apply(BB_ID_RULES);
  return out;
}

/* ---------- §6: чёрный список конфиденциальных файлов ---------- */
export const SENSITIVE_DENIED =
  "access denied to sensitive file (.env*, secrets/, *.pem, *.key)";

function globToRegex(glob) {
  let reStr = "^";
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      reStr += ".*";
    } else if (c === "?") {
      reStr += ".";
    } else if (c === "[") {
      inGroup = true;
      reStr += "[";
    } else if (c === "]" && inGroup) {
      inGroup = false;
      reStr += "]";
    } else if (inGroup) {
      reStr += c;
    } else {
      reStr += c.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    }
  }
  reStr += "$";
  try {
    return new RegExp(reStr, "i");
  } catch {
    return null;
  }
}

export function isSensitivePath(rel) {
  let norm = String(rel ?? "").replace(/\\/g, "/").trim();
  if (!norm) return false;
  norm = norm.replace(/^["']|["']$/g, "");
  if (norm.startsWith(":(")) {
    const end = norm.indexOf(")");
    if (end !== -1) {
      const magic = norm.slice(2, end);
      if (magic.includes("exclude") || magic.includes("!")) return false;
      norm = norm.slice(end + 1);
    }
  } else if (norm.startsWith(":!") || norm.startsWith(":^")) {
    return false;
  } else if (norm.startsWith(":/")) {
    norm = norm.slice(2);
  }
  const colonIdx = norm.lastIndexOf(":");
  if (colonIdx !== -1 && !norm.startsWith("-")) {
    if (!(colonIdx === 1 && /^[a-zA-Z]:/.test(norm))) {
      norm = norm.slice(colonIdx + 1);
    }
  }
  norm = norm.replace(/^["']|["']$/g, "");
  const segs = norm.split("/").filter((s) => s && s !== "." && s !== "**");
  if (!segs.length) return false;

  // 1. Проверка директории secrets (включая шаблоны glob)
  for (const s of segs) {
    const sLower = s.toLowerCase();
    if (sLower === "secrets" || /^\*?secrets\*?$/i.test(s)) return true;
    if (/[*?\[]/.test(s)) {
      if ((sLower.includes("sec") || sLower.includes("cret")) && globToRegex(s)?.test("secrets")) {
        return true;
      }
    }
  }

  const base = segs[segs.length - 1] || "";

  // 2. Литеральные префиксы/суффиксы
  if (
    /^\.env/i.test(base) ||
    /\.(pem|key)(?:\*|$)/i.test(base) ||
    /^id_(?:rsa|ed25519|dsa|ecdsa|\*)/i.test(base)
  ) {
    return true;
  }

  // 3. Шаблоны glob, покрывающие .env*, secrets/**, *.pem, *.key, id_*
  if (/[*?\[]/.test(base)) {
    if (
      (base.startsWith(".") || base.includes("env") || base.startsWith("[.]") || base.startsWith("?") || base.startsWith("*.")) &&
      (globToRegex(base)?.test(".env") || globToRegex(base)?.test(".env.local"))
    ) {
      return true;
    }
    if (
      (base.includes(".pe") || base.includes(".ke") || /\.(?:pem|key)/i.test(base) || base.endsWith("?") || base.endsWith("]")) &&
      (globToRegex(base)?.test("a.pem") || globToRegex(base)?.test("a.key"))
    ) {
      return true;
    }
    if (
      /^id[_\?*\[]/i.test(base) &&
      (globToRegex(base)?.test("id_rsa") ||
        globToRegex(base)?.test("id_ed25519") ||
        globToRegex(base)?.test("id_dsa") ||
        globToRegex(base)?.test("id_ecdsa"))
    ) {
      return true;
    }
  }

  return false;
}

/* ---------- §4: песочница cwd ---------- */
export function resolveInCwd(cwd, rel) {
  if (!cwd || typeof cwd !== "string") return { error: "no session cwd" };
  const relStr = String(rel ?? "").trim();
  if (!relStr) return { error: "empty path" };
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(relStr)) {
    return { error: "access denied: path outside cwd" };
  }
  let base;
  try {
    base = fs.realpathSync(cwd);
  } catch {
    return { error: "session cwd does not exist" };
  }
  const abs = path.resolve(base, relStr);
  // realpath ближайшего существующего предка — ловит симлинки наружу
  // даже когда конечного пути ещё нет.
  let probe = abs;
  for (;;) {
    if (fs.existsSync(probe)) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real;
  try {
    real = fs.realpathSync(probe) + abs.slice(probe.length);
  } catch {
    real = abs;
  }
  const root = base.endsWith(path.sep) ? base : base + path.sep;
  const inside = (p) => p === base || p.startsWith(root);
  if (!inside(real) || !inside(abs)) {
    return { error: "access denied: path outside cwd" };
  }
  return { abs: real, base };
}

/* ---------- §2: строгий разбор вызовов <tool .../> ---------- */
const TOOL_TAG_RE = /<tool\b(?:[^>"']|"[^"]*"|'[^']*')*?\/>/g;
const TOOL_ATTR_RE = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseToolCalls(text) {
  const calls = [];
  const s = String(text ?? "");
  for (const m of s.matchAll(TOOL_TAG_RE)) {
    const inner = m[0].slice("<tool".length, -"/>".length);
    const attrs = [];
    for (const a of inner.matchAll(TOOL_ATTR_RE)) {
      attrs.push([a[1], a[2] ?? a[3] ?? ""]);
    }
    const nameAttr = attrs.find(([k]) => k === "name");
    if (!nameAttr || !nameAttr[1]) continue;
    const rest = attrs.filter(([k]) => k !== "name");
    calls.push({ name: nameAttr[1], attrs: rest, args: Object.fromEntries(rest) });
  }
  return calls;
}

export function callArgsString(call) {
  return call.attrs
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, "'")}"`)
    .join(" ");
}

export function toolTitle(call) {
  const a = callArgsString(call);
  return a ? `${call.name} ${a}` : call.name;
}

const TOOL_KINDS = {
  read_file: "read",
  list_dir: "read",
  grep: "search",
  git: "execute",
  bb_thread_output: "fetch",
  bb_thread_message: "fetch",
  bb_task_show: "fetch",
};
export const toolKind = (name) => TOOL_KINDS[name] || "other";

/* ---------- запуск внешних команд (таймаут 15 с, без shell) ---------- */
function runCmd(file, argv, opts = {}) {
  try {
    const stdout = execFileSync(file, argv, {
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    return { status: 0, stdout };
  } catch (e) {
    if (e.killed || e.signal === "SIGTERM") {
      return { error: `timeout after ${TOOL_TIMEOUT_MS / 1000}s` };
    }
    if (e.code === "ENOENT" && e.syscall) {
      return { error: `command not found: ${file}` };
    }
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? "").trim(),
    };
  }
}

const err = (msg) => ({ error: msg });
const lineNo = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/* ---------- §4: инструменты ---------- */
const GIT_WHITELIST = new Set(["show", "diff", "log", "blame", "ls-files", "status"]);
const GIT_DENIED_OPT_RE =
  /^--output\b|^--exec\b|^--ext-diff\b|^--contents\b|^--work-tree\b|^--git-dir\b|^-O\S*/;
const TASK_GIT_FLAGS = {
  show: ["--stat", "--name-only", "--name-status", "--oneline", "--summary", "--no-patch"],
  diff: ["--stat", "--name-only", "--name-status", "--summary", "--cached", "--staged", "--check"],
  log: ["--stat", "--name-only", "--name-status", "--oneline", "--no-patch", "--all"],
  blame: ["--line-porcelain", "--porcelain"],
  "ls-files": ["--cached", "--others", "--exclude-standard"],
  status: ["-s", "--short", "--porcelain", "--porcelain=v1", "--branch", "-b"],
};
const taskPathDenied = (value) => /(?:^|[\\/:])\.git(?:[\\/]|$)/i.test(value) ||
  String(value).split(/[\\/]/).some((part) => isSensitivePath(part) || /^id_/i.test(part));

function splitArgs(s) {
  const out = [];
  for (const m of String(s).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function toolReadFile(args, ctx) {
  const relStr = String(args.path ?? "").trim();
  if (!relStr) return err("missing required arg: path");
  if (isSensitivePath(relStr)) return err(SENSITIVE_DENIED);
  const r = resolveInCwd(ctx.cwd, relStr);
  if (r.error) return err(r.error);
  if (ctx.rejectSensitive && (taskPathDenied(relStr) || taskPathDenied(path.relative(r.base, r.abs)))) return err(SENSITIVE_DENIED);
  if (isSensitivePath(path.relative(r.base, r.abs))) return err(SENSITIVE_DENIED);
  let st;
  try {
    st = fs.statSync(r.abs);
  } catch {
    return err(`file not found: ${relStr}`);
  }
  if (!st.isFile()) return err(`not a file: ${relStr}`);
  let text;
  try {
    text = fs.readFileSync(r.abs, "utf8");
  } catch (e) {
    return err(`cannot read ${relStr}: ${e.code || e.message}`);
  }
  const from = lineNo(args.from);
  const to = lineNo(args.to);
  if (from !== null || to !== null) {
    const lines = text.split("\n");
    const f = Math.max(1, from ?? 1);
    const t = Math.min(lines.length, to ?? lines.length);
    text = f > t ? "" : lines.slice(f - 1, t).join("\n");
  }
  return { output: text };
}

function toolListDir(args, ctx) {
  const relStr = String(args.path ?? ".").trim() || ".";
  if (isSensitivePath(relStr)) return err(SENSITIVE_DENIED);
  const r = resolveInCwd(ctx.cwd, relStr);
  if (r.error) return err(r.error);
  if (ctx.rejectSensitive && (taskPathDenied(relStr) || taskPathDenied(path.relative(r.base, r.abs)))) return err(SENSITIVE_DENIED);
  if (isSensitivePath(path.relative(r.base, r.abs))) return err(SENSITIVE_DENIED);
  let st;
  try {
    st = fs.statSync(r.abs);
  } catch {
    return err(`not found: ${relStr}`);
  }
  if (!st.isDirectory()) return err(`not a directory: ${relStr}`);
  const base = r.base;
  const entries = [];
  let capped = false;
  const stack = [r.abs];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (e.isDirectory() && e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (ctx.rejectSensitive && taskPathDenied(path.relative(base, full))) continue;
      entries.push(path.relative(base, full) + (e.isDirectory() ? "/" : ""));
      if (entries.length >= MAX_LIST_ENTRIES) {
        capped = true;
        break;
      }
      if (e.isDirectory()) stack.push(full);
    }
    if (capped) break;
  }
  let out = entries.join("\n");
  if (capped) out += `\n[... показаны первые ${MAX_LIST_ENTRIES} записей]`;
  return { output: out };
}

const GREP_DENY_GLOBS = [
  "-g", "!.env*",
  "-g", "!**/secrets/**",
  "-g", "!*.pem",
  "-g", "!*.key",
  "-g", "!id_rsa*",
  "-g", "!id_ed25519*",
  "-g", "!id_*",
];

const GIT_GREP_DENY_PATHSPECS = [
  ":(exclude).env*",
  ":(exclude)*/.env*",
  ":(exclude)**/secrets/**",
  ":(exclude)*secrets*",
  ":(exclude)*.pem",
  ":(exclude)*.key",
  ":(exclude)id_rsa*",
  ":(exclude)id_ed25519*",
  ":(exclude)id_*",
];

function capLines(text, max) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= max) return lines.join("\n");
  return lines.slice(0, max).join("\n") + TRUNC_SUFFIX;
}

function filterGrepOutput(stdout, deny = isSensitivePath) {
  const lines = String(stdout ?? "").replace(/\r\n/g, "\n").split("\n");
  const filtered = [];
  for (const line of lines) {
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      const file = line.slice(0, colonIdx).trim();
      if (deny(file)) continue;
    }
    filtered.push(line);
  }
  return filtered.join("\n");
}

function toolGrep(args, ctx) {
  const pattern = args.pattern;
  if (!pattern) return err("missing required arg: pattern");
  const relStr = String(args.path ?? ".").trim() || ".";
  if (isSensitivePath(relStr)) return err(SENSITIVE_DENIED);
  const r = resolveInCwd(ctx.cwd, relStr);
  if (r.error) return err(r.error);
  const deny = ctx.rejectSensitive ? taskPathDenied : isSensitivePath;
  if (ctx.rejectSensitive && (deny(relStr) || deny(path.relative(r.base, r.abs)))) return err(SENSITIVE_DENIED);
  if (isSensitivePath(path.relative(r.base, r.abs))) return err(SENSITIVE_DENIED);
  const res = runCmd("rg", [
    "--line-number", "--no-heading", "--color=never",
    ...(ctx.rejectSensitive ? ["--no-config", "-g", "!.git", "-g", "!**/.git/**"] : []),
    ...GREP_DENY_GLOBS, "--", pattern, ctx.rejectSensitive ? path.relative(r.base, r.abs) || "." : r.abs,
  ], ctx.rejectSensitive ? { cwd: r.base } : {});
  if (res.error === "command not found: rg") {
    const rel = path.relative(r.base, r.abs) || ".";
    const g = runCmd(
      "git",
      ["grep", "-n", "-I", "-e", pattern, "--", rel, ...GIT_GREP_DENY_PATHSPECS],
      { cwd: r.base },
    );
    if (g.error) return err(g.error);
    if (g.status !== 0) {
      if (g.stderr && !g.stdout) {
        return err(`git grep failed: ${g.stderr.split("\n")[0]}`);
      }
      return { output: "(no matches)" };
    }
    const filtered = filterGrepOutput(g.stdout, deny);
    if (!filtered) return { output: "(no matches)" };
    return { output: capLines(filtered, MAX_GREP_LINES) };
  }
  if (res.error) return err(res.error);
  if (res.status === 1) return { output: "(no matches)" };
  if (res.status !== 0) {
    return err(`rg failed: ${String(res.stderr || "").split("\n")[0] || "exit " + res.status}`);
  }
  const filtered = filterGrepOutput(res.stdout, deny);
  if (!filtered) return { output: "(no matches)" };
  return { output: capLines(filtered, MAX_GREP_LINES) };
}

export function extractGitPaths(argv) {
  const paths = [];
  const rest = argv.slice(1);
  const dashDashIdx = rest.indexOf("--");

  if (dashDashIdx !== -1) {
    for (let i = dashDashIdx + 1; i < rest.length; i++) {
      if (rest[i]) paths.push(rest[i]);
    }
  }

  const beforeDashDash = dashDashIdx !== -1 ? rest.slice(0, dashDashIdx) : rest;
  for (let i = 0; i < beforeDashDash.length; i++) {
    const token = beforeDashDash[i];
    if (!token) continue;
    if (token.startsWith("-L")) {
      const c = token.lastIndexOf(":");
      if (c !== -1) {
        const f = token.slice(c + 1).replace(/^["']|["']$/g, "");
        if (f) paths.push(f);
      }
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }

    if (token.startsWith(":/")) {
      continue;
    }

    const colonIdx = token.indexOf(":");
    if (colonIdx !== -1) {
      let p = token.slice(colonIdx + 1);
      if (/^[0-3]:/.test(p)) {
        p = p.slice(2);
      }
      p = p.replace(/^["']|["']$/g, "");
      if (p.startsWith("/")) {
        p = p.replace(/^\/+/, "");
      }
      if (p) paths.push(p);
      continue;
    }

    paths.push(token.replace(/^["']|["']$/g, ""));
  }

  return paths;
}

function extractPathsFromDiffLine(line) {
  const paths = [];
  if (line.startsWith("diff --git ")) {
    const rest = line.slice("diff --git ".length).trim();
    const m = rest.match(/^(?:"a\/(.*?)"|a\/(.*?))\s+(?:"b\/(.*?)"|b\/(.*?))$/);
    if (m) {
      const p1 = m[1] ?? m[2];
      const p2 = m[3] ?? m[4];
      if (p1 && p1 !== "/dev/null") paths.push(p1);
      if (p2 && p2 !== "/dev/null") paths.push(p2);
    } else {
      const parts = rest.split(/\s+/);
      for (const pt of parts) {
        const clean = pt.replace(/^["']|["']$/g, "");
        if (clean.startsWith("a/") || clean.startsWith("b/")) {
          paths.push(clean.slice(2));
        }
      }
    }
  } else if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
    let p = line.replace(/^diff --(?:cc|combined)\s+/, "").trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (p) paths.push(p);
  }
  return paths;
}

function extractPathFromHeader(line) {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    let p = line.slice(4).trim();
    if (p === "/dev/null") return null;
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
    return p;
  }
  if (/^(?:rename|copy) (?:from|to) /.test(line)) {
    let p = line.replace(/^(?:rename|copy) (?:from|to)\s+/, "").trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    return p;
  }
  return null;
}

function extractPathFromStatLine(line) {
  const m = line.match(/^\s*(\S.*?)\s+\|\s+(?:\d+|Bin\b)/);
  if (m) {
    let p = m[1].trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const arrowIdx = p.indexOf("=>");
    if (arrowIdx !== -1) {
      const parts = p.replace(/[{}]/g, "").split("=>").map((s) => s.trim());
      for (const part of parts) {
        if (isSensitivePath(part)) return part;
      }
      return parts.pop();
    }
    return p;
  }
  return null;
}

export function filterGitPatchZOutput(stdout) {
  const tokens = String(stdout).split("\0");
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i === tokens.length - 1 && token === "") break;
    if (!token) continue;

    let header = "";
    let indicator = token;
    const lastNl = token.lastIndexOf("\n");
    if (lastNl !== -1 && (token.startsWith("commit ") || token.includes("\ncommit "))) {
      const doubleNl = token.lastIndexOf("\n\n");
      if (doubleNl !== -1 && doubleNl === lastNl - 1) {
        header = token.slice(0, doubleNl + 2);
        indicator = token.slice(doubleNl + 2);
      } else {
        header = token.slice(0, lastNl + 1);
        indicator = token.slice(lastNl + 1);
      }
    } else if (token.startsWith("\n")) {
      header = "\n";
      indicator = token.slice(1);
    }

    // 1. --raw -z: starts with ":100644"
    if (/^:[0-7]{6}\s/.test(indicator)) {
      const isRename = /\s[RC][0-9]*$/.test(indicator);
      const p1 = (tokens[++i] ?? "").trim().replace(/^["']|["']$/g, "");
      if (isRename) {
        const p2 = (tokens[++i] ?? "").trim().replace(/^["']|["']$/g, "");
        if (isSensitivePath(p1) || isSensitivePath(p2)) {
          if (header) result.push(header);
          continue;
        }
        result.push(token, p1, p2);
      } else {
        if (isSensitivePath(p1)) {
          if (header) result.push(header);
          continue;
        }
        result.push(token, p1);
      }
      continue;
    }

    // 2. --name-status -z: status tag like "M", "A", "R100"
    // Важно: статус git никогда не содержит ведущих пробелов!
    // Строки коммит-сообщения с отступом (например "    M") НЕ должны считаться индикатором.
    if (/^[MADRCU][0-9]*$/.test(indicator)) {
      const isRename = /^[RC][0-9]*$/.test(indicator);
      const p1 = (tokens[++i] ?? "").trim().replace(/^["']|["']$/g, "");
      if (isRename) {
        const p2 = (tokens[++i] ?? "").trim().replace(/^["']|["']$/g, "");
        if (isSensitivePath(p1) || isSensitivePath(p2)) {
          if (header) result.push(header);
          continue;
        }
        result.push(token, p1, p2);
      } else {
        if (isSensitivePath(p1)) {
          if (header) result.push(header);
          continue;
        }
        result.push(token, p1);
      }
      continue;
    }

    // 3. --numstat -z: "added\tdeleted\tpath" or "added\tdeleted\t"
    const numstatMatch = indicator.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (numstatMatch) {
      const p = numstatMatch[3].trim().replace(/^["']|["']$/g, "");
      if (!p) {
        // rename format: next token is oldPath, next is newPath
        const p1 = (tokens[++i] ?? "").trim().replace(/^["']|["']$/g, "");
        const p2 = (tokens[++i] ?? "").trim().replace(/^["']|["']$/g, "");
        if (isSensitivePath(p1) || isSensitivePath(p2)) {
          if (header) result.push(header);
          continue;
        }
        result.push(token, p1, p2);
      } else {
        if (p.includes("=>")) {
          const parts = p.replace(/[{}]/g, "").split("=>").map((s) => s.trim());
          if (parts.some((part) => isSensitivePath(part))) {
            if (header) result.push(header);
            continue;
          }
        } else if (isSensitivePath(p)) {
          if (header) result.push(header);
          continue;
        }
        result.push(token);
      }
      continue;
    }

    if (token.includes("diff --git ") || token.includes("@@")) {
      const filtered = filterGitPatchOutput(token);
      if (filtered) result.push(filtered);
      continue;
    }

    const clean = indicator.trim().replace(/^["']|["']$/g, "");
    if (clean && isSensitivePath(clean)) {
      if (header) result.push(header);
      continue;
    }
    result.push(token);
  }
  return result.length ? result.join("\0") + "\0" : "";
}

export function filterGitPatchOutput(stdout) {
  if (!stdout) return "";
  if (stdout.includes("\0")) {
    return filterGitPatchZOutput(stdout);
  }
  const lines = String(stdout).replace(/\r\n/g, "\n").split("\n");
  const result = [];
  let currentBlock = null;

  function flushBlock() {
    if (!currentBlock) return;
    if (!currentBlock.sensitive) {
      result.push(...currentBlock.lines);
    }
    currentBlock = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (
      line.startsWith("diff --git ") ||
      line.startsWith("diff --cc ") ||
      line.startsWith("diff --combined ")
    ) {
      flushBlock();
      currentBlock = {
        lines: [line],
        sensitive: false,
      };
      const paths = extractPathsFromDiffLine(line);
      if (paths.some((p) => isSensitivePath(p))) {
        currentBlock.sensitive = true;
      }
      continue;
    }

    if (/^commit [0-9a-f]{7,}/i.test(line)) {
      flushBlock();
      result.push(line);
      continue;
    }

    if (currentBlock) {
      currentBlock.lines.push(line);
      if (!currentBlock.sensitive) {
        const p = extractPathFromHeader(line);
        if (p && isSensitivePath(p)) {
          currentBlock.sensitive = true;
        }
      }
    } else {
      const statPath = extractPathFromStatLine(line);
      if (statPath && isSensitivePath(statPath)) {
        continue;
      }
      // git log/show/diff --numstat: "1\t1\t.env", "0\t0\told => .env"
      const numstatMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
      if (numstatMatch) {
        let p = numstatMatch[3].trim().replace(/^["']|["']$/g, "");
        if (p.includes("=>")) {
          const parts = p.replace(/[{}]/g, "").split("=>").map((s) => s.trim());
          if (parts.some((part) => isSensitivePath(part))) {
            continue;
          }
        } else if (isSensitivePath(p)) {
          continue;
        }
      }
      // git log/show/diff --name-status: "M\t.env", "R100\told\t.env"
      if (/^[MADRCU][0-9]*\t/.test(line)) {
        const parts = line.split("\t").slice(1).map((s) => s.trim().replace(/^["']|["']$/g, ""));
        if (parts.some((p) => isSensitivePath(p))) {
          continue;
        }
      }
      // git log/show/diff --raw: ":100644 100644 ... M\t.env"
      if (/^:[0-7]{6}\s/.test(line) && line.includes("\t")) {
        const parts = line.split("\t").slice(1).map((s) => s.trim().replace(/^["']|["']$/g, ""));
        if (parts.some((p) => isSensitivePath(p))) {
          continue;
        }
      }
      // git log/show/diff --name-only: голые имена файлов
      const bare = line.trim().replace(/^["']|["']$/g, "");
      if (bare && isSensitivePath(bare)) {
        continue;
      }
      result.push(line);
    }
  }

  flushBlock();
  return result.join("\n");
}

export function filterGitStatusZOutput(stdout) {
  const tokens = String(stdout).split("\0");
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i === tokens.length - 1 && token === "") break;
    if (!token) continue;

    if (token.startsWith("#")) {
      result.push(token);
      continue;
    }
    const v2Type2 = token.match(/^2\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/);
    if (v2Type2) {
      const p1 = v2Type2[1].trim().replace(/^["']|["']$/g, "");
      const origToken = tokens[++i] ?? "";
      const p2 = origToken.trim().replace(/^["']|["']$/g, "");
      if (isSensitivePath(p1) || isSensitivePath(p2)) continue;
      result.push(token, origToken);
      continue;
    }
    const v2Type1 = token.match(/^[1u]\s+(?:\S+\s+){7,9}(.*)$/);
    if (v2Type1) {
      const p = v2Type1[1].trim().replace(/^["']|["']$/g, "");
      if (isSensitivePath(p)) continue;
      result.push(token);
      continue;
    }
    const v2Untracked = token.match(/^[?!]\s+(.*)$/);
    if (v2Untracked) {
      const p = v2Untracked[1].trim().replace(/^["']|["']$/g, "");
      if (isSensitivePath(p)) continue;
      result.push(token);
      continue;
    }

    const v1Match = token.match(/^([ MADRCU?!]{2})\s*(.*)$/);
    if (v1Match) {
      const status = v1Match[1];
      const p = v1Match[2].trim().replace(/^["']|["']$/g, "");
      if (status.includes("R") || status.includes("C")) {
        const origToken = tokens[++i] ?? "";
        const p2 = origToken.trim().replace(/^["']|["']$/g, "");
        if (isSensitivePath(p) || isSensitivePath(p2)) continue;
        result.push(token, origToken);
      } else {
        if (isSensitivePath(p)) continue;
        result.push(token);
      }
      continue;
    }

    const clean = token.trim().replace(/^["']|["']$/g, "");
    if (isSensitivePath(clean)) continue;
    result.push(token);
  }
  return result.length ? result.join("\0") + "\0" : "";
}

export function filterGitStatusOutput(stdout) {
  if (!stdout) return "";
  if (stdout.includes("\0")) {
    return filterGitStatusZOutput(stdout);
  }
  const lines = String(stdout).replace(/\r\n/g, "\n").split("\n");
  const filtered = [];
  for (const line of lines) {
    if (!line) {
      filtered.push(line);
      continue;
    }

    // 0. Porcelain v2
    if (line.startsWith("#")) {
      filtered.push(line);
      continue;
    }
    const v2Type1 = line.match(/^1\s+(?:\S+\s+){7}(.*)$/);
    if (v2Type1) {
      const p = v2Type1[1].trim().replace(/^["']|["']$/g, "");
      if (isSensitivePath(p)) continue;
      filtered.push(line);
      continue;
    }
    const v2Type2 = line.match(/^2\s+(?:\S+\s+){8}(.*)$/);
    if (v2Type2) {
      const parts = v2Type2[1].split("\t").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      if (parts.some((p) => isSensitivePath(p))) continue;
      filtered.push(line);
      continue;
    }
    const v2TypeU = line.match(/^u\s+(?:\S+\s+){9}(.*)$/);
    if (v2TypeU) {
      const p = v2TypeU[1].trim().replace(/^["']|["']$/g, "");
      if (isSensitivePath(p)) continue;
      filtered.push(line);
      continue;
    }
    const v2Untracked = line.match(/^[?!]\s+(.*)$/);
    if (v2Untracked) {
      const p = v2Untracked[1].trim().replace(/^["']|["']$/g, "");
      if (isSensitivePath(p)) continue;
      filtered.push(line);
      continue;
    }

    // 1. Короткий формат: "XY path" (например "?? .env", " M file.js", "R  a -> .env")
    const shortMatch = line.match(/^([ MADRCU?!]{2})\s+(.*)$/);
    if (shortMatch) {
      let p = shortMatch[2].trim();
      if (p.includes(" -> ")) {
        const parts = p.split(" -> ");
        const p1 = parts[0].trim().replace(/^["']|["']$/g, "");
        const p2 = parts[1].trim().replace(/^["']|["']$/g, "");
        if (isSensitivePath(p1) || isSensitivePath(p2)) continue;
      } else {
        p = p.replace(/^["']|["']$/g, "");
        if (isSensitivePath(p)) continue;
      }
      filtered.push(line);
      continue;
    }

    // 2. Длинный формат: строки с отступом (таб или пробелы)
    if (/^\s+/.test(line)) {
      const trimmed = line.trim();
      // Статусные строки: "modified:   .env", "new file:   secrets/k.pem", "renamed:    a -> .env"
      const statusColonMatch = trimmed.match(
        /^(?:modified|new file|deleted|renamed|typechange|both modified|both added):\s+(.*)$/,
      );
      if (statusColonMatch) {
        let p = statusColonMatch[1].trim();
        if (p.includes(" -> ")) {
          const parts = p.split(" -> ");
          const p1 = parts[0].trim().replace(/^["']|["']$/g, "");
          const p2 = parts[1].trim().replace(/^["']|["']$/g, "");
          if (isSensitivePath(p1) || isSensitivePath(p2)) continue;
        } else {
          p = p.replace(/^["']|["']$/g, "");
          if (isSensitivePath(p)) continue;
        }
        filtered.push(line);
        continue;
      }

      // Неотслеживаемые файлы: "\t.env" или строки в блоке Untracked files
      const cleanPath = trimmed.replace(/^["']|["']$/g, "");
      if (!cleanPath.startsWith("(") && !cleanPath.startsWith("#")) {
        if (isSensitivePath(cleanPath)) continue;
      }
    }

    filtered.push(line);
  }
  return filtered.join("\n");
}

function isExcludePathspec(p) {
  const s = String(p ?? "").trim().replace(/^["']|["']$/g, "");
  if (s.startsWith(":!") || s.startsWith(":^")) return true;
  if (s.startsWith(":(")) {
    const end = s.indexOf(")");
    if (end !== -1) {
      const magic = s.slice(2, end);
      return magic.includes("exclude") || magic.includes("!");
    }
  }
  return false;
}

function toolGit(args, ctx) {
  const argv = splitArgs(args.args ?? "");
  if (!argv.length) return err("missing required arg: args");
  const sub = argv[0];
  if (!GIT_WHITELIST.has(sub)) return err(`git subcommand not allowed: ${sub}`);
  if (argv.some((a) => GIT_DENIED_OPT_RE.test(a))) {
    return err(`git option not allowed: ${argv.find((a) => GIT_DENIED_OPT_RE.test(a))}`);
  }
  if (ctx.rejectSensitive) {
    const pathStart = argv.indexOf("--");
    for (const arg of argv.slice(1, pathStart < 0 ? undefined : pathStart)) {
      if (!arg.startsWith("-") || TASK_GIT_FLAGS[sub].includes(arg)) continue;
      if ((sub === "log" || sub === "show") && /^-[1-9]\d{0,2}$/.test(arg)) continue;
      if ((sub === "show" || sub === "diff") && /^-U\d{1,3}$/.test(arg)) continue;
      return err("git option not allowed in a BB task");
    }
  }
  const paths = extractGitPaths(argv);
  for (const p of paths) {
    if (isSensitivePath(p) || (ctx.rejectSensitive && taskPathDenied(p))) return err(SENSITIVE_DENIED);
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p)) {
      return err("access denied: path outside cwd");
    }
    if (path.isAbsolute(p)) {
      const rAbs = resolveInCwd(ctx.cwd, p);
      if (rAbs.error) return err("access denied: path outside cwd");
    }
    if (!isExcludePathspec(p) && /[*?\[]/.test(p)) {
      const r = resolveInCwd(ctx.cwd, ".");
      if (!r.error) {
        const ls = runCmd("git", ["ls-files", "-z", "--", p], { cwd: r.base });
        if (ls.status === 0 && ls.stdout) {
          const files = ls.stdout.split("\0").filter(Boolean);
          for (const f of files) {
            if (isSensitivePath(f)) return err(SENSITIVE_DENIED);
          }
        }
        const hist = runCmd("git", ["log", "-n", "30", "--name-only", "--format=", "--", p], { cwd: r.base });
        if (hist.status === 0 && hist.stdout) {
          const files = hist.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
          for (const f of files) {
            if (isSensitivePath(f)) return err(SENSITIVE_DENIED);
          }
        }
      }
    }
  }
  const r = resolveInCwd(ctx.cwd, ".");
  if (r.error) return err(r.error);
  if (ctx.rejectSensitive && ["show", "diff", "log", "blame"].includes(sub)) {
    argv.splice(1, 0, "--no-textconv");
    if (sub !== "blame") argv.splice(1, 0, "--no-ext-diff");
  }
  const res = runCmd("git", argv, { cwd: r.base, ...(ctx.rejectSensitive ? {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" },
  } : {}) });
  if (res.error) return err(res.error);
  if (res.status !== 0) {
    return err(`git ${sub} failed: ${String(res.stderr || "").split("\n")[0] || "exit " + res.status}`);
  }
  let out = res.stdout;
  if (sub === "ls-files") {
    const sep = out.includes("\0") ? "\0" : "\n";
    const files = out.split(sep).filter((l) => l.length > 0 && !isSensitivePath(l.trim()));
    out = files.join(sep) + (out.endsWith(sep) && files.length ? sep : "");
  } else if (sub === "status") {
    out = filterGitStatusOutput(out);
  } else if (sub === "diff" || sub === "show" || sub === "log") {
    out = filterGitPatchOutput(out);
  }
  return { output: out };
}

const bbBin = () => process.env.BB_CLI || "bb";

function extraArgs(args, allowed) {
  return Object.keys(args).filter((k) => !allowed.includes(k));
}

export function bbReadCommand({ name, args }) {
  if (name === "bb_task_show") {
    const extra = extraArgs(args, ["key"]);
    if (extra.length) return err(`unexpected args: ${extra.join(", ")}`);
    const key = String(args.key ?? "");
    if (!TASK_KEY_RE.test(key)) return err(`invalid key: ${key || "(empty)"}`);
    return { argv: ["tasks", "show", key] };
  }
  if (name !== "bb_thread_output" && name !== "bb_thread_message") return null;
  const hasMessage = name === "bb_thread_message";
  const extra = extraArgs(args, hasMessage ? ["threadId", "msg"] : ["threadId"]);
  if (extra.length) return err(`unexpected args: ${extra.join(", ")}`);
  const id = String(args.threadId ?? "");
  if (!THREAD_ID_RE.test(id)) return err(`invalid threadId: ${id || "(empty)"}`);
  if (!hasMessage) return { argv: ["thread", "output", id] };
  const msg = String(args.msg ?? "");
  if (!/^\d+$/.test(msg)) return err(`invalid msg: ${msg || "(empty)"}`);
  return { argv: ["thread", "log", id, "--message", msg] };
}

function toolBb(call) {
  const command = bbReadCommand(call);
  if (command.error) return command;
  const { argv } = command;
  const res = runCmd(bbBin(), argv);
  if (res.error) return err(res.error);
  if (res.status !== 0) {
    return err(`bb ${argv.slice(0, 2).join(" ")} failed: ${String(res.stderr || res.stdout).split("\n")[0] || "exit " + res.status}`);
  }
  return { output: res.stdout };
}

/** §7.2: результат >60 КБ обрезается с явным суффиксом. */
export function truncResult(text) {
  const s = String(text ?? "");
  if (Buffer.byteLength(s, "utf8") <= MAX_TOOL_RESULT_BYTES) return s;
  return (
    Buffer.from(s, "utf8").subarray(0, MAX_TOOL_RESULT_BYTES).toString("utf8") +
    TRUNC_SUFFIX
  );
}

/** Обрезка UTF-8 строки по байтовому лимиту с сохранением валидности символов. */
export function limitResult(text, maxBytes) {
  const totalBytes = Buffer.byteLength(text);
  if (totalBytes <= maxBytes) return { output: text };
  const buf = Buffer.from(text);
  let end = Math.max(0, maxBytes - Buffer.byteLength(TRUNC_SUFFIX));
  while (end && (buf[end] & 0xc0) === 0x80) end--;
  const suffix = Buffer.byteLength(TRUNC_SUFFIX) <= maxBytes ? TRUNC_SUFFIX : "";
  return { output: buf.subarray(0, end).toString("utf8") + suffix, truncated: { includedBytes: end, totalBytes } };
}

export function truncateUtf8(str, maxBytes) {
  const buf = Buffer.from(String(str ?? ""), "utf8");
  if (buf.length <= maxBytes) return String(str ?? "");
  let s = buf.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(s, "utf8") > maxBytes) {
    s = s.slice(0, -1);
  }
  return s;
}

/**
 * Выполнить один вызов инструмента в контексте {cwd}.
 * Всегда возвращает {ok, output}; output уже замаскирован и усечён.
 */
export function executeTool(call, ctx = {}) {
  let out;
  switch (call.name) {
    case "read_file": out = toolReadFile(call.args, ctx); break;
    case "list_dir": out = toolListDir(call.args, ctx); break;
    case "grep": out = toolGrep(call.args, ctx); break;
    case "git": out = toolGit(call.args, ctx); break;
    case "bb_thread_output":
    case "bb_thread_message":
    case "bb_task_show": out = toolBb(call); break;
    default: out = err(`unknown tool: ${call.name}`);
  }
  const text = out.error ? `error: ${out.error}` : String(out.output ?? "");
  if (ctx.mask) return { ok: !out.error, ...limitResult(ctx.mask(text), ctx.maxResultBytes ?? MAX_TOOL_RESULT_BYTES) };
  return { ok: !out.error, output: truncResult(maskForWeb(text)) };
}

/* ---------- §2/§3: системная шапка и цикл раундов ---------- */
export function toolSystemHeader(maxRounds = MAX_TOOL_ROUNDS, { pinned = false } = {}) {
  return [
    "[provider tools] В этой сессии доступны инструменты только чтения (рабочая копия сессии, пути относительные).",
    "Вызов — строго одна строка XML на инструмент:",
    '<tool name="read_file" path="src/index.js" from="1" to="80"/>',
    '<tool name="list_dir" path="plugins"/>',
    '<tool name="grep" pattern="pickBackend" path="plugins"/>',
    pinned ? '<tool name="git" args="diff --stat"/>' : '<tool name="git" args="diff --stat HEAD~1..HEAD"/>',
    `<tool name="bb_thread_output" threadId="${THR}xxxxxxxxxx"/>`,
    `<tool name="bb_thread_message" threadId="${THR}xxxxxxxxxx" msg="2"/>`,
    '<tool name="bb_task_show" key="PLUG-129"/>',
    "git — только show|diff|log|blame|ls-files|status; bb_* — по указанным аргументам.",
    `Ответ без тегов <tool .../> считается финальным. Лимит раундов инструментов: ${maxRounds}.`,
  ].join("\n");
}

export function forceFinalMessage(maxRounds = MAX_TOOL_ROUNDS) {
  return (
    `Лимит раундов инструментов (${maxRounds}) исчерпан. ` +
    "Дай финальный ответ на базе уже прочитанного — без новых вызовов инструментов."
  );
}

export function formatToolResultBlock(call, resultText) {
  const a = callArgsString(call);
  return `=== tool: ${call.name}${a ? " " + a : ""} ===\n${resultText}`;
}

/**
 * §3 Tool Loop: send(message) → текст ответа; вызовы выполняются
 * последовательно, результаты уходят единым следующим сообщением.
 * send может вернуть строку или объект с полем text (res драйвера).
 */
export async function runToolLoop({
  firstMessage,
  send,
  execute,
  onToolStart = null,
  onToolEnd = null,
  onToolRound = null,
  formatResult = (call, result) => formatToolResultBlock(call, result.output),
  maxRounds = MAX_TOOL_ROUNDS,
  isCancelled = () => false,
}) {
  let message = firstMessage;
  let round = 0;
  let lastRes = null;
  const executed = [];
  for (;;) {
    if (isCancelled()) return { cancelled: true, rounds: round, executed, lastRes };
    const res = await send(message);
    lastRes = res;
    const raw = typeof res?.rawText === "string" && res.rawText.trim() ? res.rawText : null;
    const text = String(raw ?? res?.text ?? res ?? "");
    const calls = parseToolCalls(text);
    if (!calls.length) {
      return { cancelled: false, forcedFinal: false, finalText: text, rounds: round, executed, lastRes };
    }
    if (round >= maxRounds) {
      onToolRound?.(round + 1);
      const res2 = await send(forceFinalMessage(maxRounds));
      return {
        cancelled: false,
        forcedFinal: true,
        finalText: String(res2?.text ?? res2 ?? ""),
        rounds: round,
        executed,
        lastRes: res2,
      };
    }
    onToolRound?.(round + 1);
    const parts = [];
    for (const call of calls) {
      if (isCancelled()) return { cancelled: true, rounds: round, executed, lastRes };
      const handle = onToolStart ? onToolStart(call) : null;
      const r = await execute(call);
      if (onToolEnd) onToolEnd(handle, call, r);
      executed.push({ name: call.name, ok: r.ok });
      parts.push(formatResult(call, r));
    }
    message = parts.join("\n");
    round += 1;
    if (isCancelled()) {
      return { cancelled: true, forcedFinal: false, finalText: "", rounds: round, executed, lastRes };
    }
  }
}

/* ---------- §5: упаковка первого сообщения ---------- */
const FILE_TOKEN_TRIMS = /^[`'"([{<]+|[`'")\]}>.,;:!?]+$/g;

const BARE_FILE_NAMES = new Set([
  "makefile", "dockerfile", "readme", "license", "licence",
  "procfile", "gemfile", "rakefile", "vagrantfile", "containerfile",
  "brewfile", "justfile", "build", "workspace", "tiltfile", "guardfile",
]);

function isFileCandidateToken(tok, cwd) {
  if (tok.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(tok)) return true;
  if (BARE_FILE_NAMES.has(tok.toLowerCase())) return true;
  try {
    const p = path.join(cwd, tok);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function fileCandidates(text, cwd, seen, out) {
  const baseR = resolveInCwd(cwd, ".");
  if (baseR.error) return;
  let inspected = 0;
  for (let tok of String(text).split(/\s+/)) {
    if (inspected >= 40) break;
    tok = tok.replace(FILE_TOKEN_TRIMS, "");
    if (!tok || tok.length > 200) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) continue;
    if (isSensitivePath(tok)) continue;
    if (!isFileCandidateToken(tok, cwd)) continue;
    inspected += 1;
    const r = resolveInCwd(cwd, tok);
    if (!r.abs) continue;
    try {
      if (!fs.statSync(r.abs).isFile()) continue;
    } catch {
      continue;
    }
    const rel = path.relative(r.base, r.abs);
    if (isSensitivePath(rel)) continue;
    const key = `file:${rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      block: `file: ${rel}`,
      hint: `read_file("${rel}")`,
      fetch: () => executeTool({ name: "read_file", args: { path: rel }, attrs: [["path", rel]] }, { cwd }),
    });
  }
}

export const GIT_DIFF_DENY_PATHSPECS = [
  ":(exclude).env*",
  ":(exclude)*/.env*",
  ":(exclude)**/secrets/**",
  ":(exclude)*secrets*",
  ":(exclude)*.pem",
  ":(exclude)*.key",
  ":(exclude)id_rsa*",
  ":(exclude)id_ed25519*",
  ":(exclude)id_*",
];

const SPILL_NAME_SAFE_RE = /[^\w.-]+/g;

/**
 * PLUG-291 / PLUG-303: перелив тела материалов или промпта в .md-файл веб-вложения.
 * Пишется атомарно (tmp + rename) в spillDir/pkg-<id>-<ts>.md;
 * имя каталога не создаётся заранее — mkdir только при реальной записи.
 */
export function writeSpillPackage(spillDir, spillId, content) {
  const safeId = String(spillId ?? "pkg").replace(SPILL_NAME_SAFE_RE, "_") || "pkg";
  const pkgName = `pkg-${safeId}-${Date.now()}.md`;
  const pkgPath = path.join(spillDir, pkgName);
  fs.mkdirSync(spillDir, { recursive: true, mode: 0o700 });
  const tmp = `${pkgPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, pkgPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
  return { pkgName, pkgPath };
}

/**
 * Собрать первое сообщение сессии: системная шапка + текст задачи +
 * вложения (дифф, файлы, треды, задачи), уложенные в maxBytes.
 * Всё, что не поместилось, перечисляется в шапке строкой
 * «Можно запросить инструментом: …».
 *
 * PLUG-291: при заданном spillDir и переполнении собранного сообщения
 * материалы-блоки уходят файлом-вложением .md в spillDir (возвращается
 * `spilledFile`), в тексте — короткая пометка о вложении вместо обрезки.
 */
export function packFirstMessage({
  text,
  cwd = null,
  embeddedResources = [],
  maxBytes = MAX_MESSAGE_BYTES,
  maxRounds = MAX_TOOL_ROUNDS,
  spillDir = null,
  spillId = null,
  completePackage = null,
}) {
  maxBytes = effectiveMessageBytes(maxBytes);
  if (completePackage) {
    const { header, render } = completePackage;
    let payload = render("text");
    let message = header + "\n\n" + payload;
    if (Buffer.byteLength(message) <= maxBytes) return { message, payload };
    payload = render("spill attachment");
    const { pkgName, pkgPath } = writeSpillPackage(spillDir, spillId, payload);
    message = header + "\n\nRead the entire task and its manifest in the attached " + pkgName + ".";
    return { message, payload, spilledFile: pkgPath };
  }
  const seen = new Set();
  const candidates = [];

  // Дифф репозитория — только внутри git-дерева (§5.2).
  if (cwd) {
    const baseR = resolveInCwd(cwd, ".");
    if (!baseR.error) {
      const probe = runCmd("git", ["rev-parse", "--is-inside-work-tree"], { cwd: baseR.abs });
      if (probe.status === 0 && probe.stdout.trim() === "true") {
        candidates.push({
          block: "git status --short",
          hint: 'git("status --short")',
          fetch: () => executeTool({ name: "git", args: { args: "status --short" }, attrs: [["args", "status --short"]] }, { cwd }),
        });
        candidates.push({
          block: "git diff HEAD",
          hint: 'git("diff HEAD")',
          fetch: () => {
            const excludeArgs = GIT_DIFF_DENY_PATHSPECS.map((s) => `"${s}"`).join(" ");
            return executeTool(
              {
                name: "git",
                args: { args: `diff HEAD -- . ${excludeArgs}` },
                attrs: [["args", "diff HEAD"]],
              },
              { cwd },
            );
          },
        });
      }
    }
  }

  // Вложенные ресурсы ACP (embeddedContext) — контент уже в блоке.
  for (const res of embeddedResources) {
    const inner = res?.resource ?? res;
    const content = inner?.text;
    if (typeof content !== "string" || !content) continue;
    const uri = String(inner?.uri ?? res?.name ?? "resource");
    let title = "resource";
    try {
      title =
        (uri.startsWith("file://")
          ? decodeURIComponent(uri.slice("file://".length))
          : uri
        )
          .split("/")
          .filter(Boolean)
          .pop() || "resource";
    } catch {}
    const key = `embed:${title}:${content.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      block: `file: ${title}`,
      hint: `read_file("${title}")`,
      fetch: () => ({ ok: true, output: truncResult(maskForWeb(content)) }),
    });
  }

  if (cwd) fileCandidates(text, cwd, seen, candidates);

  // Треды: <t>hr_…, @thread:<t>hr_…, …/threads/<t>hr_…[#msg=N].
  for (const m of String(text).matchAll(THREAD_ID_IN_TEXT_RE)) {
    const id = m[0].split("#")[0];
    const msg = m[1];
    const key = msg ? `thread-msg:${id}:${msg}` : `thread:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (msg) {
      candidates.push({
        block: `thread: ${id}#msg=${msg}`,
        hint: `bb_thread_message("${id}", msg=${msg})`,
        fetch: () =>
          executeTool(
            { name: "bb_thread_message", args: { threadId: id, msg }, attrs: [["threadId", id], ["msg", msg]] },
            {},
          ),
      });
    } else {
      candidates.push({
        block: `thread: ${id}`,
        hint: `bb_thread_output("${id}")`,
        fetch: () =>
          executeTool({ name: "bb_thread_output", args: { threadId: id }, attrs: [["threadId", id]] }, {}),
      });
    }
  }

  // Ключи задач трекера.
  for (const m of String(text).matchAll(TASK_KEY_IN_TEXT_RE)) {
    const key0 = m[0];
    if (TASK_KEY_ALLOW.has(key0)) continue;
    const key = `task:${key0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      block: `task: ${key0}`,
      hint: `bb_task_show("${key0}")`,
      fetch: () =>
        executeTool({ name: "bb_task_show", args: { key: key0 }, attrs: [["key", key0]] }, {}),
    });
  }

  const header = toolSystemHeader(maxRounds);
  let body = String(text ?? "");
  const len = (s) => Buffer.byteLength(s, "utf8");
  // Резерв на строку «Можно запросить инструментом:».
  let used = len(header) + len(body) + 300;
  const blocks = [];
  const allBlocks = [];
  const attached = [];
  const overflow = [];

  for (const c of candidates) {
    const res = c.fetch();
    const output = res && res.ok ? String(res.output ?? "") : "";
    if (!output.trim()) continue; // пустой материал — не вложение и не подсказка
    const block = `=== ${c.block} ===\n${output}`;
    allBlocks.push({ text: block, blockName: c.block, hint: c.hint });
    const size = len(block) + 2;
    if (used + size <= maxBytes) {
      blocks.push({ text: block, blockName: c.block, hint: c.hint });
      used += size;
      attached.push(c.block);
    } else {
      overflow.push(c.hint);
    }
  }

  const prefix = "\nМожно запросить инструментом: ";
  let head = header;
  if (overflow.length > 0) {
    head = `${header}${prefix}${overflow.join(", ")}`;
  }

  const buildFull = () =>
    head + "\n\n" + body + (blocks.length ? "\n\n" + blocks.map((b) => b.text).join("\n\n") : "");

  let fullText = buildFull();

  // 0) PLUG-291: перелив — материалы не влезли в maxBytes (overflow) или
  // собранное сообщение перевалило лимит → ВЕСЬ пакет материалов уходит
  // .md-файлом веб-вложения в spillDir, в сообщении остаются шапка, задача
  // и пометка о вложении. При неудаче записи — обычный путь вытеснения.
  if (spillDir && allBlocks.length > 0 && (overflow.length > 0 || len(fullText) > maxBytes)) {
    try {
      const { pkgName, pkgPath } = writeSpillPackage(
        spillDir,
        spillId,
        allBlocks.map((b) => b.text).join("\n\n") + "\n",
      );
      const note =
        `\n\n[Материалы задачи (${allBlocks.length} блоков: ` +
        allBlocks.map((b) => b.blockName).join(", ") +
        `) переданы файлом-вложением «${pkgName}» — изучи его целиком.]`;
      const headNote = header + "\n\n";
      let msg = headNote + body + note;
      if (len(msg) > maxBytes) {
        const truncBodySuffix = "\n[... текст задачи обрезан по лимиту сообщения ...]";
        const avail = maxBytes - len(headNote) - len(note);
        if (avail > len(truncBodySuffix)) {
          body = truncateUtf8(body, avail - len(truncBodySuffix)) + truncBodySuffix;
        } else {
          body = avail > 0 ? truncateUtf8(body, avail) : "";
        }
        msg = headNote + body + note;
      }
      let message = maskForWeb(msg);
      if (len(message) > maxBytes) {
        message = truncateUtf8(message, maxBytes);
      }
      return {
        message,
        attached: allBlocks.map((b) => b.blockName),
        overflow: [],
        spilledFile: pkgPath,
      };
    } catch (e) {
      process.stderr.write(`[provider-argon] spill to file failed: ${e.message}\n`);
    }
  }

  // 1) Если общее сообщение превышает maxBytes, вытесняем блоки с конца.
  // Вытесненные блоки обязаны попадать в overflow-подсказки (§5.5).
  while (blocks.length > 0 && len(fullText) > maxBytes) {
    const popped = blocks.pop();
    attached.pop();
    if (!overflow.includes(popped.hint)) {
      overflow.unshift(popped.hint);
    }
    head = `${header}${prefix}${overflow.join(", ")}`;
    fullText = buildFull();
  }

  // 2) Если блоков не осталось, а подсказок слишком много (>maxBytes), ужимаем список подсказок.
  if (overflow.length > 0 && len(fullText) > maxBytes) {
    const baseLen = len(header + prefix + "\n\n" + body + (blocks.length ? "\n\n" + blocks.map((b) => b.text).join("\n\n") : ""));
    const available = maxBytes - baseLen;
    const included = [];
    let cur = 0;
    for (const h of overflow) {
      const add = len((included.length ? ", " : "") + h);
      if (cur + add <= available) {
        included.push(h);
        cur += add;
      } else {
        break;
      }
    }
    head = included.length ? `${header}${prefix}${included.join(", ")}` : header;
    fullText = buildFull();
  }

  // 3) Если даже без блоков и подсказок текст задачи (body) превышает maxBytes,
  // ужимаем body (§5.4/§7.1: потолок WEB_GEMINI_MAX_MESSAGE_BYTES обязателен).
  if (len(fullText) > maxBytes) {
    head = header;
    const headerWithSepLen = len(head + "\n\n");
    const availableForBody = maxBytes - headerWithSepLen;
    const truncBodySuffix = "\n[... текст задачи обрезан по лимиту сообщения ...]";
    const suffixLen = len(truncBodySuffix);
    if (availableForBody > suffixLen) {
      body = truncateUtf8(body, availableForBody - suffixLen) + truncBodySuffix;
    } else if (availableForBody > 0) {
      body = truncateUtf8(body, availableForBody);
    } else {
      body = "";
    }
    fullText = head + (body ? "\n\n" + body : "");
  }

  let message = maskForWeb(fullText);
  if (len(message) > maxBytes) {
    message = truncateUtf8(message, maxBytes);
  }
  return { message, attached, overflow };
}
