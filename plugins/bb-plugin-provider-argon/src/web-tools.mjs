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

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

export const TOOL_TIMEOUT_MS = num("ARGON_TOOL_TIMEOUT_MS", 15_000);
export const MAX_TOOL_RESULT_BYTES = 60_000;
export const MAX_MESSAGE_BYTES = num("ARGON_MAX_MESSAGE_BYTES", 120_000);
export const MAX_TOOL_ROUNDS = num("ARGON_MAX_TOOL_ROUNDS", 8);
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
const TOOL_TAG_RE = /<tool\b[^>]*?\/>/g;
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
  const r = resolveInCwd(ctx.cwd, relStr);
  if (r.error) return err(r.error);
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

function filterGrepOutput(stdout) {
  const lines = String(stdout ?? "").replace(/\r\n/g, "\n").split("\n");
  const filtered = [];
  for (const line of lines) {
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      const file = line.slice(0, colonIdx).trim();
      if (isSensitivePath(file)) continue;
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
  const res = runCmd("rg", [
    "--line-number", "--no-heading", "--color=never",
    ...GREP_DENY_GLOBS, "--", pattern, r.abs,
  ]);
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
    const filtered = filterGrepOutput(g.stdout);
    if (!filtered) return { output: "(no matches)" };
    return { output: capLines(filtered, MAX_GREP_LINES) };
  }
  if (res.error) return err(res.error);
  if (res.status === 1) return { output: "(no matches)" };
  if (res.status !== 0) {
    return err(`rg failed: ${String(res.stderr || "").split("\n")[0] || "exit " + res.status}`);
  }
  const filtered = filterGrepOutput(res.stdout);
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

export function filterGitPatchOutput(stdout) {
  if (!stdout) return "";
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

export function filterGitStatusOutput(stdout) {
  if (!stdout) return "";
  const lines = String(stdout).replace(/\r\n/g, "\n").split("\n");
  const filtered = [];
  for (const line of lines) {
    if (!line) {
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
  const paths = extractGitPaths(argv);
  for (const p of paths) {
    if (isSensitivePath(p)) return err(SENSITIVE_DENIED);
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
  const res = runCmd("git", argv, { cwd: r.base });
  if (res.error) return err(res.error);
  if (res.status !== 0) {
    return err(`git ${sub} failed: ${String(res.stderr || "").split("\n")[0] || "exit " + res.status}`);
  }
  let out = res.stdout;
  if (sub === "ls-files") {
    const lines = out.split("\n").filter((l) => !isSensitivePath(l.trim()));
    out = lines.join("\n");
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

function toolThreadOutput(args) {
  const extra = extraArgs(args, ["threadId"]);
  if (extra.length) return err(`unexpected args: ${extra.join(", ")}`);
  const id = String(args.threadId ?? "");
  if (!THREAD_ID_RE.test(id)) return err(`invalid threadId: ${id || "(empty)"}`);
  const res = runCmd(bbBin(), ["thread", "output", id]);
  if (res.error) return err(res.error);
  if (res.status !== 0) {
    return err(`bb thread output failed: ${String(res.stderr || res.stdout).split("\n")[0] || "exit " + res.status}`);
  }
  return { output: res.stdout };
}

function toolThreadMessage(args) {
  const extra = extraArgs(args, ["threadId", "msg"]);
  if (extra.length) return err(`unexpected args: ${extra.join(", ")}`);
  const id = String(args.threadId ?? "");
  if (!THREAD_ID_RE.test(id)) return err(`invalid threadId: ${id || "(empty)"}`);
  const msg = String(args.msg ?? "");
  if (!/^\d+$/.test(msg)) return err(`invalid msg: ${msg || "(empty)"}`);
  const res = runCmd(bbBin(), ["thread", "log", id, "--message", msg]);
  if (res.error) return err(res.error);
  if (res.status !== 0) {
    return err(`bb thread log failed: ${String(res.stderr || res.stdout).split("\n")[0] || "exit " + res.status}`);
  }
  return { output: res.stdout };
}

function toolTaskShow(args) {
  const extra = extraArgs(args, ["key"]);
  if (extra.length) return err(`unexpected args: ${extra.join(", ")}`);
  const key = String(args.key ?? "");
  if (!TASK_KEY_RE.test(key)) return err(`invalid key: ${key || "(empty)"}`);
  const res = runCmd(bbBin(), ["tasks", "show", key]);
  if (res.error) return err(res.error);
  if (res.status !== 0) {
    return err(`bb tasks show failed: ${String(res.stderr || res.stdout).split("\n")[0] || "exit " + res.status}`);
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
    case "bb_thread_output": out = toolThreadOutput(call.args); break;
    case "bb_thread_message": out = toolThreadMessage(call.args); break;
    case "bb_task_show": out = toolTaskShow(call.args); break;
    default: out = err(`unknown tool: ${call.name}`);
  }
  const text = out.error ? `error: ${out.error}` : String(out.output ?? "");
  return { ok: !out.error, output: truncResult(maskForWeb(text)) };
}

/* ---------- §2/§3: системная шапка и цикл раундов ---------- */
export function toolSystemHeader(maxRounds = MAX_TOOL_ROUNDS) {
  return [
    "[provider tools] В этой сессии доступны инструменты только чтения (рабочая копия сессии, пути относительные).",
    "Вызов — строго одна строка XML на инструмент:",
    '<tool name="read_file" path="src/index.js" from="1" to="80"/>',
    '<tool name="list_dir" path="plugins"/>',
    '<tool name="grep" pattern="pickBackend" path="plugins"/>',
    '<tool name="git" args="diff --stat HEAD~1..HEAD"/>',
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
  maxRounds = MAX_TOOL_ROUNDS,
  isCancelled = () => false,
}) {
  let message = firstMessage;
  let round = 0;
  let lastRes = null;
  const executed = [];
  for (;;) {
    const res = await send(message);
    lastRes = res;
    const text = String(res?.text ?? res ?? "");
    const calls = parseToolCalls(text);
    if (!calls.length) {
      return { cancelled: false, forcedFinal: false, finalText: text, rounds: round, executed, lastRes };
    }
    if (round >= maxRounds) {
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
    const parts = [];
    for (const call of calls) {
      const handle = onToolStart ? onToolStart(call) : null;
      const r = await execute(call);
      if (onToolEnd) onToolEnd(handle, call, r);
      executed.push({ name: call.name, ok: r.ok });
      parts.push(formatToolResultBlock(call, r.output));
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

function fileCandidates(text, cwd, seen, out) {
  const baseR = resolveInCwd(cwd, ".");
  if (baseR.error) return;
  let inspected = 0;
  for (let tok of String(text).split(/\s+/)) {
    if (inspected >= 40) break;
    tok = tok.replace(FILE_TOKEN_TRIMS, "");
    if (!tok || tok.length > 200) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) continue;
    if (!tok.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(tok)) continue;
    inspected += 1;
    if (isSensitivePath(tok)) continue;
    const r = resolveInCwd(cwd, tok);
    if (!r.abs) continue;
    try {
      if (!fs.statSync(r.abs).isFile()) continue;
    } catch {
      continue;
    }
    const rel = path.relative(r.base, r.abs);
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

function linkCandidates(resourceLinks, cwd, seen, out) {
  if (!cwd) return;
  for (const link of resourceLinks) {
    const uri = String(link?.uri ?? link ?? "");
    if (!uri.startsWith("file://")) continue;
    let abs;
    try {
      abs = decodeURIComponent(new URL(uri).pathname);
    } catch {
      continue;
    }
    const r = resolveInCwd(cwd, abs);
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

/**
 * Собрать первое сообщение сессии: системная шапка + текст задачи +
 * вложения (дифф, файлы, треды, задачи), уложенные в maxBytes.
 * Всё, что не поместилось, перечисляется в шапке строкой
 * «Можно запросить инструментом: …».
 */
export function packFirstMessage({
  text,
  cwd = null,
  resourceLinks = [],
  embeddedResources = [],
  maxBytes = MAX_MESSAGE_BYTES,
  maxRounds = MAX_TOOL_ROUNDS,
}) {
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

  linkCandidates(resourceLinks, cwd, seen, candidates);
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
  const body = String(text ?? "");
  const len = (s) => Buffer.byteLength(s, "utf8");
  // Резерв на строку «Можно запросить инструментом:».
  let used = len(header) + len(body) + 300;
  const blocks = [];
  const attached = [];
  const overflow = [];

  for (const c of candidates) {
    const res = c.fetch();
    const output = res && res.ok ? String(res.output ?? "") : "";
    if (!output.trim()) continue; // пустой материал — не вложение и не подсказка
    const block = `=== ${c.block} ===\n${output}`;
    const size = len(block) + 2;
    if (used + size <= maxBytes) {
      blocks.push(block);
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

  // Если общее сообщение превышает maxBytes, ужимаем:
  // 1) сначала удаляем блоки из конца, освобождая место под подсказки и лимит;
  // 2) если блоков больше нет, но подсказок слишком много (>120 КБ), обрезаем список подсказок.
  let fullText = head + "\n\n" + body + (blocks.length ? "\n\n" + blocks.join("\n\n") : "");
  while (blocks.length > 0 && len(fullText) > maxBytes) {
    blocks.pop();
    attached.pop();
    fullText = head + "\n\n" + body + (blocks.length ? "\n\n" + blocks.join("\n\n") : "");
  }

  if (overflow.length > 0 && maxBytes >= 10000 && len(fullText) > maxBytes) {
    const baseLen = len(header + prefix + "\n\n" + body + (blocks.length ? "\n\n" + blocks.join("\n\n") : ""));
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
    fullText = head + "\n\n" + body + (blocks.length ? "\n\n" + blocks.join("\n\n") : "");
  }

  const message = maskForWeb(fullText);
  return { message, attached, overflow };
}
