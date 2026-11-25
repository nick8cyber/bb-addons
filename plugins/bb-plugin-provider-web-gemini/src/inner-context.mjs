import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as tools from "./web-tools.mjs";
import { agentSettings } from "./fast-agent.mjs";
import { collectDiff, executePinned, pinReview, readMaterial, readTextFile, repoRoot, worktreeStatus } from "./review-git.mjs";
import { deserializeVerdict } from "./turn-journal.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const runFile = promisify(execFile);
const DEFAULT_TOTAL = 25_000_000;
const REVIEW_LINE = /^(?:Проверяемый итог: коммит|Result under review: commit)[ \t]+(\S+)(?:[ \t]+\([^)]*\))?[ \t]*$/;
const REVIEW_PREFIX = /^(?:Проверяемый итог: коммит|Result under review: commit)(?:\s|$)/;
const ATTACHED_PATHS = /^(?:Приложенные файлы \(прочитай в репозитории\)|Attached files \(read them in the repo\)):[ \t]*(.+)$/;
const AUDITOR = /(?:^|\n)[ \t]*(?:[-*][ \t]+)?(?:Заканчивай отчёт строкой JSON|End the report with the JSON line)[ \t]+\{"verdict":"OK"\|"CHANGES","blockers":<[^>\n]+>\}/;
// PLUG-384: явные признаки публичного research — строка оркестратора
// «задача без кода» / "no-code task" в Additional instructions либо роль
// ресерчера в системных инструкциях. Для такого хода пакет лёгкий: без
// git-секций, инвентаря быстрого агента и манифеста разрешений.
const NO_CODE = /^(?:задача без кода|no-code task)[\s:—-]/i;
const RESEARCHER = /Ты — ресерчер|You are the researcher\b/;
const FILE_ATTACHMENT_ID = "[0-9A-HJKMNP-TV-Z]{26}";
const TRACKER_ATTACHMENT = new RegExp("^- (.+) · (" + FILE_ATTACHMENT_ID + ")$");
const THREAD_TOKEN = new RegExp("\\b" + tools.THREAD_ID_RE.source.slice(1, -1) + "\\b", "gi");
const TASK_TOKEN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b(?!\s*(?:charset|encoding))/g;
export const TRACKER_PROJECT_PREFIXES = ["IAM", "PLUG", "GH", "NET", "SMK", "CRM", "TGD", "VERBA", "ZE", "RU"];
export const TRACKER_TASK_KEY_RE = new RegExp(`\\b(?:${TRACKER_PROJECT_PREFIXES.join("|")})-\\d+\\b(?!\\.\\d)`, "g");
export const SEARCH_DIRECTIVE = "Найди ответ в интернете через поиск Google. Для каждого факта укажи ссылку на источник и дату.";
export const BB_SERVICE_HEADINGS = [
  "## Project context",
  "## Sub-tasks",
  "## Attachments",
  "## Recent comments",
  "## Report-back contract",
  "## Preset instructions",
  "## Additional instructions",
];
const bytes = (text) => Buffer.byteLength(text);
const digest = (text) => createHash("sha256").update(text).digest("hex");
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

async function bb(args, signal) {
  const { stdout } = await runFile(process.env.BB_CLI || "bb", args, {
    signal, timeout: tools.TOOL_TIMEOUT_MS, maxBuffer: DEFAULT_TOTAL, encoding: "utf8",
  });
  return stdout;
}

export async function taskThread(threadId, signal) {
  if (!threadId) return null;
  if (!tools.THREAD_ID_RE.test(threadId)) throw new Error("invalid BB thread identity");
  let dto;
  try {
    dto = JSON.parse(await bb(["thread", "show", threadId, "--json"], signal));
  } catch {
    throw new Error("could not read trusted BB thread metadata");
  }
  if (dto?.thread?.id !== threadId) throw new Error("BB thread metadata does not match the launch");
  return dto;
}

export function loadSettings(stateDir, projectId) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(join(stateDir, "inner-agent.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("invalid inner-agent.json");
  }
  if (!record(input) || ["context", "apply", "innerAgent", "state"].some((key) => input[key] !== undefined && !record(input[key]))) {
    throw new Error("invalid inner-agent.json settings");
  }
  const setting = (value, fallback, min, name) => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > 2_147_483_647) throw new Error("invalid " + name);
    return value;
  };
  const patterns = input.context?.maskPatterns ?? {};
  if (!record(patterns)) throw new Error("invalid context.maskPatterns");
  const allowed = Object.hasOwn(patterns, projectId) ? patterns[projectId] : [];
  if (!Array.isArray(allowed)) throw new Error("invalid project context.maskPatterns");
  const compiled = allowed.map((rule) => {
    const { type, pattern } = rule ?? {};
    if (typeof type !== "string" || !/^[\p{L}\p{N}_-]{1,48}$/u.test(type) || typeof pattern !== "string" || !pattern) {
      throw new Error("invalid project context.maskPatterns rule");
    }
    try {
      return { type, re: new RegExp(pattern, "gu") };
    } catch {
      throw new Error("invalid project context.maskPatterns expression");
    }
  });
  const maxTotalBytes = setting(input.context?.maxTotalBytes, DEFAULT_TOTAL, 1, "context.maxTotalBytes");
  const optionalBytesRaw = setting(input.context?.optionalAttachmentBytes, 240_000, 0, "context.optionalAttachmentBytes");
  const optionalAttachmentBytes = Math.min(optionalBytesRaw, maxTotalBytes);
  return Object.freeze({
    innerAgent: agentSettings(input.innerAgent, setting),
    maxTotalBytes,
    optionalAttachmentBytes,
    maxRepairRounds: setting(input.apply?.maxRepairRounds, 2, 0, "apply.maxRepairRounds"),
    progressIntervalMs: setting(input.progressIntervalMs, 15_000, 1, "progressIntervalMs"),
    stateRetentionMs: setting(input.state?.retentionMs, 86_400_000, 1, "state.retentionMs"),
    mask(text) {
      let value = String(text);
      for (const { type, re } of compiled) value = value.replace(re, () => "[скрыто: " + type + "]");
      return tools.maskForWeb(value)
        .replace(/(\b(?:https?|ftp):\/\/)[^\s/@]+(?=@)/gi, "$1[скрыто: credentials]")
        .replace(THREAD_TOKEN, "[скрыто: bb-thread-id]")
        .replace(TASK_TOKEN, (token) => tools.isTaskKeyToken(token) ? "[скрыто: task-key]" : token);
    },
    maskResearch(text, currentKey = null) {
      let value = String(text);
      for (const { type, re } of compiled) value = value.replace(re, () => "[скрыто: " + type + "]");
      value = tools.maskForWeb(value)
        .replace(/(\b(?:https?|ftp):\/\/)[^\s/@]+(?=@)/gi, "$1[скрыто: credentials]")
        .replace(THREAD_TOKEN, "[скрыто: bb-thread-id]");
      if (currentKey && tools.isTaskKeyToken(currentKey)) {
        const escaped = currentKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        value = value.replace(new RegExp(`\\b${escaped}\\b(?!\\.\\d)`, "g"), "[скрыто: task-key]");
      }
      return value.replace(TRACKER_TASK_KEY_RE, (token) => tools.isTaskKeyToken(token) ? "[скрыто: task-key]" : token);
    },
    maskResponse(text) {
      let value = String(text);
      for (const { type, re } of compiled) value = value.replace(re, () => "[скрыто: " + type + "]");
      return tools.maskForWeb(value)
        .replace(/(\b(?:https?|ftp):\/\/)[^\s/@]+(?=@)/gi, "$1[скрыто: credentials]");
    },
  });
}

function section(text, heading, { last = false } = {}) {
  const rows = text.split(/\r?\n/);
  const matches = (line) => heading.test(line);
  const start = last ? rows.findLastIndex(matches) : rows.findIndex(matches);
  if (start === -1) return [];
  const end = rows.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return rows.slice(start + 1, end === -1 ? undefined : end);
}

function parseVerdict(text, system, pin) {
  const explicit = [...text.matchAll(/\{[^{}]{1,2000}\}/g)].filter(([template]) =>
    /"verdict"\s*:/.test(template) && /"blockers"\s*:/.test(template)).filter((match) => {
    const before = text.slice(Math.max(0, match.index - 250), match.index);
    return /(?:\b(?:last|final|end|finish|verdict)\b|последн|заканчивай|заверши|вердикт)/i.test(before.split(/\n\s*\n/).at(-1));
  }).map(([template]) => template);
  if (!pin && !explicit.length && !AUDITOR.test(system ?? "")) return null;
  const fields = new Map();
  for (const template of explicit) {
    for (const [, name, value] of template.matchAll(/"([A-Za-z_]\w*)"\s*:\s*((?:"[^"]*"(?:\s*\|\s*"[^"]*")*)|true|false|[+-]?\d+(?:\.\d+)?|[A-Z]+|<[^>]+>)/g)) {
      if (name === "verdict" || name === "blockers") continue;
      const choices = value.startsWith('"') ? [...value.matchAll(/"([^"]*)"/g)].map((match) => match[1]) : [];
      const kind = choices.length ? "enum" : /^(true|false)$/.test(value) ? "boolean" : "number";
      const field = fields.get(name) ?? { kind, values: [] };
      if (field.kind === kind) field.values.push(...choices);
      fields.set(name, field);
    }
  }
  return fields;
}

export function extractAttachmentSearchText(additionalLines) {
  const result = [];
  let inGit = false;
  for (const line of additionalLines) {
    if (inGit) {
      if (line.trim() === "") inGit = false;
      continue;
    }
    if (/^\s*(?:Работа с git|Git work):/.test(line)) {
      inGit = true;
      continue;
    }
    if (/^\s*(?:Приложенные файлы \(прочитай в репозитории\)|Attached files \(read them in the repo\))/i.test(line)) continue;
    if (/^\s*(?:Проверяемый итог: коммит|Result under review: commit)/i.test(line)) continue;
    if (/^\s*Диапазон проверки спецификации/i.test(line)) continue;
    result.push(line);
  }
  return result.join("\n");
}

export function resolveOrchestratorDataDir() {
  const custom = process.env.WEB_GEMINI_ORCHESTRATOR_DATA_DIR;
  if (custom && custom.trim() !== "") return resolve(custom);
  const bbData = process.env.BB_DATA_DIR;
  if (bbData && bbData.trim() !== "") return resolve(bbData, "plugins", "orchestrator");
  const home = process.env.HOME || homedir();
  return resolve(home, ".bb", "plugins", "orchestrator");
}

export function findOrchestratorAuditPackageCandidates(searchText) {
  if (!searchText) return [];
  const candidates = [];
  const regex = /(?:^|[\s"'`\(\[\{<«“‘])((?:\/|~\/)[^\s"'`\)\]\}>»”’]+)/g;
  let match;
  while ((match = regex.exec(searchText)) !== null) {
    const raw = match[1].replace(/[.,;:]+$/, "");
    if (!raw) continue;
    const rawSegments = raw.split("/");
    if (rawSegments.some((s) => s === "." || s === "..")) {
      continue;
    }
    const home = process.env.HOME || homedir();
    const expanded = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
    const fileName = basename(expanded);
    if (!/^release-[0-9]+-audit\.md$/.test(fileName)) {
      continue;
    }
    const dirName = dirname(expanded);
    const orchDataDir = resolveOrchestratorDataDir();
    const allowedRoots = [resolve(orchDataDir)];
    try {
      const realRoot = realpathSync(orchDataDir);
      if (realRoot && !allowedRoots.includes(realRoot)) {
        allowedRoots.push(realRoot);
      }
    } catch {}

    const isMatch = allowedRoots.some((r) => resolve(dirName) === resolve(r, "release-audit"));
    if (isMatch) {
      candidates.push({ raw, expanded, fileName });
    }
  }
  return candidates;
}

export function isAttachmentNamed(text, id, name) {
  if (id && text.includes(id)) return true;
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[^A-Za-z0-9._/\\\\-])${escaped}(?:$|[^A-Za-z0-9._-])`);
  return re.test(text);
}

function compareAttachmentsNewestFirst(a, b) {
  const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (timeA !== timeB) return timeB - timeA;
  return String(b.id).localeCompare(String(a.id));
}

function buildSkippedAttachmentsBlock(omittedOptional, mask = (t) => t) {
  if (!omittedOptional || omittedOptional.length === 0) return "";
  const byReason = {
    budget: [],
    "not text": [],
    "download failed": [],
  };
  for (const item of omittedOptional) {
    if (byReason[item.reason]) {
      byReason[item.reason].push(mask(item.name));
    }
  }
  const lines = [];
  if (byReason["budget"].length) {
    lines.push(`Не вошли по бюджету (${byReason["budget"].length}): ${byReason["budget"].join(", ")}`);
  }
  if (byReason["not text"].length) {
    lines.push(`Пропущены как нетекстовые (${byReason["not text"].length}): ${byReason["not text"].join(", ")}`);
  }
  if (byReason["download failed"].length) {
    lines.push(`Не скачались (${byReason["download failed"].length}): ${byReason["download failed"].join(", ")}`);
  }
  if (lines.length === 0) return "";
  return "=== Вложения задачи, не вошедшие в пакет ===\n" + lines.join("\n");
}

export async function prepareTask({ text, system, session, thread, stateDir, signal, onSettings, savedTurn }) {
  if (!text.trim()) throw new Error("task text is empty");
  if (!session.cwd || !isAbsolute(session.cwd)) throw new Error("task requires an absolute session working directory");
  let cwd;
  try {
    cwd = realpathSync(session.cwd);
    if (!statSync(cwd).isDirectory() || !thread.environment?.path || realpathSync(thread.environment.path) !== cwd) throw new Error();
    if (thread.environment?.id !== thread.thread.environmentId && thread.thread.environmentId) throw new Error();
    if (thread.environment.projectId && thread.environment.projectId !== thread.thread.projectId) throw new Error();
  } catch {
    throw new Error("task working directory does not match trusted BB environment");
  }
  const settings = loadSettings(stateDir, thread.thread.projectId);
  onSettings?.(settings);
  const additional = section(text, /^## (?:Additional instructions|Дополнительные инструкции)[ \t]*$/, { last: true });
  const attachmentSearchText = extractAttachmentSearchText(additional);
  const refs = [];
  const repoFiles = [];
  for (const line of additional) {
    if (REVIEW_PREFIX.test(line)) {
      const ref = REVIEW_LINE.exec(line)?.[1];
      if (!ref) throw new Error("malformed review commit instruction");
      refs.push(ref);
    }
    const listed = ATTACHED_PATHS.exec(line)?.[1];
    if (listed) repoFiles.push(...listed.split(", ").map((item) => item.replace(/^\x60|\x60$/g, "")));
  }
  const root = await repoRoot(cwd, signal);
  const pin = savedTurn ? savedTurn.pin : await pinReview(root, refs, thread.environment ?? {}, signal);
  const verdict = savedTurn ? deserializeVerdict(savedTurn.verdict) : parseVerdict(text, system, pin);
  const key = /^# ([A-Z][A-Z0-9]{1,9}-\d+) · /m.exec(text)?.[1];
  // PLUG-384: признак на первом ходу или сохранённый в записи сессии —
  // повторные ходы исследовательской сессии остаются лёгкими без маркера.
  const research = !pin && !verdict &&
    (session?.journal?.record?.research === true ||
      additional.some((line) => NO_CODE.test(line)) || RESEARCHER.test(system ?? ""));
  const attachments = [];
  const attachmentOmissions = [];
  const pairMatches = [...text.matchAll(/(?:^|\n)## Attachments[ \t]*\r?\n((?:(?!##[ \t])[^\n]*\r?\n)*?)(?=## Recent comments[ \t]*(?:\r?\n|$))/g)];
  const attachmentRows = pairMatches.length
    ? pairMatches.at(-1)[1].split(/\r?\n/)
    : section(text, /^## Attachments[ \t]*$/, { last: true });
  for (const line of attachmentRows) {
    if (!line.startsWith("- ")) continue;
    const match = TRACKER_ATTACHMENT.exec(line);
    if (!match) {
      attachmentOmissions.push({ line, reason: "malformed tracker attachment entry" });
      continue;
    }
    attachments.push({ name: match[1], id: match[2] });
  }
  return { text, settings, verdict, cwd, root, pin, repoFiles, attachments, attachmentOmissions: attachmentOmissions ?? [], attachmentSearchText, key, thread: thread.thread, research };
}

export function verdictInstruction(context) {
  if (!context.verdict) return "";
  const extra = [...context.verdict].map(([key, field]) =>
    ", " + JSON.stringify(key) + ": " + (field.kind === "enum" ? [...new Set(field.values)].map(JSON.stringify).join(" | ") : field.kind)).join("");
  return context.settings.mask(
    'Договор вердикта / Verdict contract. Last nonblank line after the report: one standalone JSON object, no Markdown fence. ' +
    'Последняя содержательная строка после отчёта — отдельный JSON-объект без Markdown-ограды. ' +
    '{"verdict": "OK" | "CHANGES", "blockers": nonnegative integer' + extra + '}.',
  );
}

export function taskInstruction(context) {
  if (!context.write) return verdictInstruction(context);
  const { nonce, allowedPaths } = context.write;
  const mark = "BBG-" + nonce;
  return [
    "File output contract. Your final response must be a single Markdown fence with no other text or fences.",
    "The outer fence must be strictly longer than any fence of the same character inside file content; otherwise use tildes.",
    "Inside the fence, each on its own line: " + mark + "-ENVELOPE, the META line, the file blocks, " + mark + "-CLOSE.",
    'META is one JSON line: {"format":"web-gemini-files-v2","nonce":"' + nonce +
      '","commitMessage":"...","files":[{"path":"...","operation":"...","baseSha256":"..."}]}. META contains no file content.',
    "Each files entry: path (exact relative path), operation (create, replace, delete), baseSha256. " +
      "Use null for create. For replace or delete, use the base SHA-256 provided by the manifest or read_file. " +
      "Ask read_file if the hash has not been provided. Do not compute it yourself.",
    "After META, for every create or replace entry in files order: " + mark + "-FILE-NN-BEGIN, " +
      "the complete raw file content, " + mark + "-FILE-NN-END. NN is the two-digit index of the entry in files " +
      "plus one; delete entries keep their number but have no FILE block.",
    "Content between the marker lines is verbatim: no escaping, no trimming; keep line endings and the final LF. " +
      "Never emit a line starting with " + mark + "- inside file content. No other lines before ENVELOPE or after CLOSE.",
    "A reply requesting tools must contain only tool call lines. The final file response must contain only the envelope fence.",
    allowedPaths ? "Allowed paths: " + JSON.stringify(allowedPaths) : "",
  ].filter(Boolean).join("\n");
}

async function fileBaseInfo(context, path) {
  if (!context.write || typeof path !== "string" || context.settings.mask(path) !== path) return null;
  try {
    const info = await context.writer.baseInfo(context.writeHead, path);
    if (info) {
      const bases = new Map(context.write.bases);
      bases.set(path, info);
      context.write.bases = [...bases];
    }
    return info;
  } catch (error) {
    return { unavailable: context.settings.mask(error.code ? "file base is unavailable" : error.message) };
  }
}

function finalLine(text) {
  return String(text).match(/(?:^|\n)([^\n]*\S[^\n]*)(?:\r?\n[ \t\r]*)*$/)?.[1]?.replace(/\r$/, "") ?? "";
}

export function checkedAnswer(context, response) {
  const page = String(response?.text ?? response ?? "");
  const raw = typeof response?.rawText === "string" && response.rawText.trim() ? response.rawText : null;
  const source = raw ?? page;
  const isFileEnvelope = (text) => /"format"\s*:\s*"web-gemini-files-v\d+"/.test(text) ||
    /^BBG-\S+-ENVELOPE[ \t\r]*$/m.test(text);
  if (isFileEnvelope(source) || isFileEnvelope(page) || response?.files?.length || response?.hasGeneratedFile) {
    return { denied: "file output requires a write-enabled preset and a dedicated worktree; full grants read-only access" };
  }
  const isLightResearch = context.research && !context.write;
  if (!isLightResearch) {
    if (!source.trim() || tools.parseToolCalls(source).length || tools.parseToolCalls(page).length ||
        /<tool\b/i.test(source) || /<tool\b/i.test(page)) return { repair: "empty or unfinished tool response" };
  } else {
    if (!source.trim()) return { repair: "empty response" };
  }
  if (context.settings.maskResponse(source) !== source || context.settings.maskResponse(page) !== page) {
    return { repair: "response contains material prohibited for publication", prohibited: true };
  }
  if (!context.verdict) return { text: page.trim() ? page : source };
  const line = finalLine(source);
  let json;
  try { json = JSON.parse(line); } catch { return { repair: "last line must be the verdict JSON object" }; }
  if (!record(json) || !["OK", "CHANGES"].includes(json.verdict) || !Number.isSafeInteger(json.blockers) || json.blockers < 0) {
    return { repair: "verdict or blockers is invalid" };
  }
  for (const [key, field] of context.verdict) {
    if (!Object.hasOwn(json, key) || (field.kind === "enum" ? !field.values.includes(json[key]) : typeof json[key] !== field.kind)) {
      return { repair: "an additional required verdict field is missing or invalid" };
    }
  }
  return { text: source };
}

function blockFile(block) {
  if (block.type === "resource_link" && typeof block.uri === "string" && block.uri.startsWith("file:")) {
    return fileURLToPath(block.uri);
  }
  if (["image", "localFile", "localImage"].includes(block.type) && typeof block.path === "string" && block.path.trim()) {
    return block.path;
  }
  return null;
}

const inside = (root, absolute) => {
  const file = relative(root, absolute);
  return file && !isAbsolute(file) && file !== ".." && !file.startsWith("../") ? file : null;
};

function explicitLinks(context, blocks) {
  const links = new Set(blocks.filter((block) => block.type === "resource_link" && block.uri && !block.uri.startsWith("file:")).map((block) => block.uri));
  for (const [url] of context.text.matchAll(/(?:https?|ftp):\/\/[^\s<>"'()[\]\x60]+/g)) links.add(url.replace(/[.,;]+$/, ""));
  const threadRef = tools.THREAD_ID_RE.source.slice(1, -1);
  const threadLink = new RegExp("@thread:(" + threadRef + ")(?:#msg=(\\d+))?", "gi");
  for (const [link] of context.text.matchAll(threadLink)) links.add(link);
  for (const [, key] of context.text.matchAll(/::task\{key="([A-Z][A-Z0-9]{1,9}-\d+)"/g)) links.add("task:" + key);
  return links;
}

function linkCall(link) {
  const idPattern = tools.THREAD_ID_RE.source.slice(1, -1);
  const thread = new RegExp("^(?:@thread:|https?://[a-z0-9-]+\\.getbb\\.app/[^?\\s]*threads/)(" + idPattern + ")(?:#msg=(\\d+))?$", "i").exec(link);
  if (thread) return { name: thread[2] ? "bb_thread_message" : "bb_thread_output", args: { threadId: thread[1], ...(thread[2] ? { msg: thread[2] } : {}) } };
  const key = /^task:([A-Z][A-Z0-9]{1,9}-\d+)$/.exec(link)?.[1];
  return key ? { name: "bb_task_show", args: { key } } : null;
}

export async function collectTaskAttachments(context, blocks, options) {
  const { signal, maxUploadBytes, maxUploadCount, validateUploads, spillDir } = options;
  const { root, pin, settings } = context;
  const maxBytes = settings.maxTotalBytes;
  const isLightResearch = context.research && !context.write;
  const mask = isLightResearch ? (str) => settings.maskResearch(str, context.key) : settings.mask;
  const materials = [];
  let uploadCount = 0;
  let materialBytes = 0;
  const add = (source, text, { name, at, upload = false, required = true, createdAt, id, maskedSha256 }) => {
    const maskedText = mask(text);
    const size = bytes(maskedText);
    if (upload && (++uploadCount > maxUploadCount || bytes(text) > maxUploadBytes || size > maxUploadBytes)) {
      throw new Error("mandatory attachment exceeds upload count or size limit");
    }
    materialBytes += size;
    if (materialBytes > maxBytes) throw new Error("mandatory task context exceeds byte budget");
    materials.push({
      source,
      text,
      name,
      at,
      upload,
      required,
      createdAt,
      id,
      maskedSha256: maskedSha256 ?? digest(maskedText),
    });
  };
  for (const block of blocks) {
    signal.throwIfAborted();
    if (block.type === "resource") {
      const uri = String(block.resource?.uri ?? "embedded resource");
      const name = uri.startsWith("file:") ? basename(uri) : uri;
      if (typeof block.resource?.text !== "string" || /^(?:image|audio|video)\//i.test(block.resource?.mimeType ?? "")) {
        throw new Error("mandatory embedded resource is not text");
      }
      add("Embedded resource", block.resource.text, { name, at: "ACP input", upload: false, required: true });
    }
  }
  // PLUG-384: публичный research — без авто-подобранных локальных файлов
  // (перечисленных в инструкциях путей репозитория). Явно приложенные
  // ACP-источники (resource_link/localFile на текст) собираются через
  // действующую ACP-валидацию, как и в репо-режиме: молчаливая потеря
  // обязательного вложения запрещена, неприемлемое — явный отказ.
  const light = context.research && !context.write;
  if (!light) for (const file of new Set(context.repoFiles)) {
    try {
      add("Repository attachment", await readMaterial(root ?? context.cwd, pin, file, maxBytes, signal), { name: file, upload: false, required: true });
    } catch {
      throw new Error("mandatory repository attachment could not be collected");
    }
  }

  const externalBlocks = [];
  const seenPaths = new Set();
  for (const block of blocks) {
    const file = blockFile(block);
    if (["image", "audio", "localImage"].includes(block.type) || /^(?:image|audio|video)\//i.test(block.mimeType ?? "")) {
      throw new Error("mandatory attachment is binary");
    }
    if (!file) continue;
    const abs = resolve(context.cwd, file);
    const repoFile = root && inside(root, abs);
    if (seenPaths.has(abs)) continue;
    seenPaths.add(abs);
    if (!light && pin && repoFile) {
      add("Repository attachment", await readMaterial(root, pin, repoFile, maxUploadBytes, signal), {
        name: repoFile, at: pin.sha, upload: false, required: true,
      });
    } else {
      externalBlocks.push(block);
    }
  }
  if (externalBlocks.length) {
    const result = validateUploads(externalBlocks, { limitCount: light });
    if (result.error) throw new Error("mandatory ACP attachment is inaccessible or exceeds upload limits");
    for (const file of result.files) {
      add("ACP attachment", await readTextFile(file, maxUploadBytes, signal), {
        name: basename(file), at: "ACP input", upload: light, required: true,
      });
    }
  }

  const omittedOptional = [];
  let mandatoryCount = 0;
  let includedOptionalCount = 0;
  let omittedBudgetCount = 0;
  let omittedNotTextCount = 0;
  let omittedDownloadFailedCount = 0;

  if (!light) {
    const searchText = context.attachmentSearchText ?? (context.text ? extractAttachmentSearchText(section(context.text, /^## (?:Additional instructions|Дополнительные инструкции)[ \t]*$/, { last: true })) : "");
    const auditCandidates = findOrchestratorAuditPackageCandidates(searchText);
    const seenAuditPaths = new Set();
    for (const cand of auditCandidates) {
      if (seenAuditPaths.has(cand.expanded)) continue;
      seenAuditPaths.add(cand.expanded);
      const fileName = cand.fileName;

      let st;
      try {
        st = statSync(cand.expanded);
      } catch {
        throw new Error("mandatory audit package is missing: " + mask(fileName));
      }
      if (!st.isFile()) {
        throw new Error("mandatory audit package is not a regular file: " + mask(fileName));
      }

      let resolvedPath;
      try {
        resolvedPath = realpathSync(cand.expanded);
      } catch {
        throw new Error("mandatory audit package is missing: " + mask(fileName));
      }
      const orchDataDir = resolveOrchestratorDataDir();
      let realAuditDir;
      try {
        realAuditDir = realpathSync(join(orchDataDir, "release-audit"));
      } catch {
        realAuditDir = null;
      }
      const resolvedDir = dirname(resolvedPath);
      const resolvedName = basename(resolvedPath);
      if (!realAuditDir || resolvedDir !== realAuditDir || !/^release-[0-9]+-audit\.md$/.test(resolvedName)) {
        throw new Error("mandatory audit package outside allowed roots: " + mask(fileName));
      }

      const realSt = statSync(resolvedPath);
      if (!realSt.isFile()) {
        throw new Error("mandatory audit package is not a regular file: " + mask(fileName));
      }

      const effectiveMaxUploadBytes = Number.isFinite(Number(process.env.WEB_GEMINI_MAX_UPLOAD_BYTES)) && Number(process.env.WEB_GEMINI_MAX_UPLOAD_BYTES) > 0
        ? (options.maxUploadBytes ? Math.min(options.maxUploadBytes, Number(process.env.WEB_GEMINI_MAX_UPLOAD_BYTES)) : Number(process.env.WEB_GEMINI_MAX_UPLOAD_BYTES))
        : (options.maxUploadBytes ?? 25 * 1024 * 1024);
      if (realSt.size > effectiveMaxUploadBytes) {
        throw new Error("mandatory audit package exceeds upload limit: " + mask(fileName));
      }

      const pathParts = resolvedPath.split("/").filter(Boolean);
      if (pathParts.some((part) => tools.isSensitivePath(part)) || tools.isSensitivePath(resolvedPath)) {
        throw new Error("mandatory audit package is sensitive path: " + mask(fileName));
      }

      let rawBuf;
      try {
        rawBuf = readFileSync(resolvedPath);
      } catch {
        throw new Error("mandatory audit package could not be read: " + mask(fileName));
      }
      if (rawBuf.includes(0)) {
        throw new Error("mandatory audit package is binary: " + mask(fileName));
      }
      let text;
      try {
        text = decoder.decode(rawBuf);
      } catch {
        throw new Error("mandatory audit package is not permitted text: " + mask(fileName));
      }

      const maskedText = mask(text);
      const size = bytes(maskedText);
      if (materialBytes + size > maxBytes) {
        throw new Error("mandatory audit package exceeds byte budget: " + mask(fileName));
      }
      mandatoryCount++;
      add("orchestrator-data", text, {
        name: fileName,
        at: resolvedPath,
        resolvedPath,
        upload: false,
        required: true,
        maskedSha256: digest(maskedText),
      });
    }
  }

  if (!light && context.attachments?.length) {
    const searchText = context.attachmentSearchText ?? (context.text ? extractAttachmentSearchText(section(context.text, /^## (?:Additional instructions|Дополнительные инструкции)[ \t]*$/, { last: true })) : "");
    let shown = null;
    let cardError = null;
    try {
      if (!context.key) throw new Error("tracker attachments require a task key");
      const raw = await bb(["tasks", "show", context.key, "--json"], signal);
      shown = JSON.parse(raw);
      if (shown.task?.key !== context.key || shown.project?.linkedBbProjectId !== context.thread?.projectId ||
          !shown.taskThreads?.some((entry) => entry.threadId === context.thread?.id)) {
        throw new Error("tracker attachment task does not match the current BB thread");
      }
    } catch (err) {
      cardError = err;
    }

    const taskAtts = context.attachments;
    const namedById = new Set();
    const namedByName = new Set();

    for (const att of taskAtts) {
      if (att.id && searchText.includes(att.id)) namedById.add(att.id);
    }

    if (shown?.attachments) {
      const byName = new Map();
      for (const att of taskAtts) {
        const cardEntry = shown.attachments.find((item) => item.id === att.id);
        const fileName = cardEntry?.fileName ?? att.name;
        if (!byName.has(fileName)) byName.set(fileName, []);
        byName.get(fileName).push({
          id: att.id,
          name: fileName,
          createdAt: cardEntry?.createdAt ?? null,
          cardEntry,
        });
      }
      for (const [name, list] of byName.entries()) {
        if (isAttachmentNamed(searchText, null, name)) {
          list.sort(compareAttachmentsNewestFirst);
          namedByName.add(list[0].id);
        }
      }
    } else {
      for (const att of taskAtts) {
        if (isAttachmentNamed(searchText, null, att.name)) {
          namedByName.add(att.id);
        }
      }
    }

    const isMandatory = (att) => namedById.has(att.id) || namedByName.has(att.id);

    if (cardError) {
      const anyMandatory = taskAtts.find(isMandatory);
      if (anyMandatory) {
        throw new Error("mandatory tracker attachment task card could not be confirmed: " + mask(anyMandatory.name));
      }
      for (const att of taskAtts) {
        omittedOptional.push({ id: att.id, name: att.name, reason: "download failed" });
        omittedDownloadFailedCount++;
      }
    } else {
      const mandatoryList = [];
      const optionalList = [];
      const seen = new Set();

      for (const att of taskAtts) {
        if (seen.has(att.id)) continue;
        seen.add(att.id);
        const cardEntry = shown.attachments?.find((item) => item.id === att.id);
        const item = {
          id: att.id,
          name: cardEntry?.fileName ?? att.name,
          createdAt: cardEntry?.createdAt ?? null,
          sizeBytes: cardEntry?.sizeBytes,
          isImage: cardEntry?.isImage === true,
          cardEntry,
          mandatory: isMandatory(att),
        };
        if (item.mandatory) {
          mandatoryList.push(item);
        } else {
          optionalList.push(item);
        }
      }

      mkdirSync(spillDir, { recursive: true, mode: 0o700 });
      const scratch = mkdtempSync(join(spillDir, "tracker-"));
      try {
        for (const item of mandatoryList) {
          mandatoryCount++;
          if (!item.cardEntry) {
            throw new Error("mandatory tracker attachment is missing: " + mask(item.name));
          }
          if (item.isImage) {
            throw new Error("mandatory tracker attachment is not permitted text: " + mask(item.name));
          }
          if (Number.isFinite(item.sizeBytes) && item.sizeBytes > maxUploadBytes) {
            throw new Error("mandatory tracker attachment exceeds upload limit: " + mask(item.name));
          }
          const dest = join(scratch, randomUUID());
          try {
            await bb(["tasks", "attachment", "get", item.id, "--out", dest], signal);
          } catch {
            throw new Error("mandatory tracker attachment could not be downloaded: " + mask(item.name));
          }
          let text;
          try {
            text = await readTextFile(dest, maxUploadBytes, signal);
          } catch {
            throw new Error("mandatory tracker attachment is not permitted text: " + mask(item.name));
          }
          const masked = mask(text);
          const size = bytes(masked);
          if (size > maxUploadBytes) {
            throw new Error("mandatory tracker attachment exceeds upload limit: " + mask(item.name));
          }
          if (materialBytes + size > maxBytes) {
            throw new Error("mandatory tracker attachment exceeds byte budget: " + mask(item.name));
          }
          add("Tracker attachment", text, {
            name: item.name,
            at: item.createdAt ?? "BB Tasks input",
            upload: false,
            required: true,
            createdAt: item.createdAt,
            id: item.id,
            maskedSha256: digest(masked),
          });
        }

        optionalList.sort(compareAttachmentsNewestFirst);
        let optionalBudgetRemaining = settings.optionalAttachmentBytes;
        const taskTextBytes = context.text ? bytes(mask(context.text)) : 0;
        const occupiedCoreBytes = (options.coreBytes ?? taskTextBytes) + (options.reserveBytes ?? 0);
        let remainingBudget = Math.max(0, maxBytes - materialBytes - occupiedCoreBytes);

        for (const item of optionalList) {
          signal.throwIfAborted();
          if (!item.cardEntry) {
            omittedOptional.push({ id: item.id, name: item.name, reason: "download failed" });
            omittedDownloadFailedCount++;
            continue;
          }
          if (item.isImage) {
            omittedOptional.push({ id: item.id, name: item.name, reason: "not text" });
            omittedNotTextCount++;
            continue;
          }
          const effectiveBudget = Math.min(optionalBudgetRemaining, remainingBudget);
          if (Number.isFinite(item.sizeBytes) && (item.sizeBytes > effectiveBudget || item.sizeBytes > maxUploadBytes)) {
            omittedOptional.push({ id: item.id, name: item.name, reason: "budget" });
            omittedBudgetCount++;
            continue;
          }
          const dest = join(scratch, randomUUID());
          try {
            await bb(["tasks", "attachment", "get", item.id, "--out", dest], signal);
          } catch {
            omittedOptional.push({ id: item.id, name: item.name, reason: "download failed" });
            omittedDownloadFailedCount++;
            continue;
          }
          let text;
          try {
            text = await readTextFile(dest, maxUploadBytes, signal);
          } catch (e) {
            const isNonText = /binary|non-UTF-8|not a permitted text file/i.test(e?.message ?? "");
            const reason = isNonText ? "not text" : "download failed";
            omittedOptional.push({ id: item.id, name: item.name, reason });
            if (reason === "not text") omittedNotTextCount++;
            else omittedDownloadFailedCount++;
            continue;
          }
          const masked = mask(text);
          const size = bytes(masked);
          if (size > effectiveBudget || size > maxUploadBytes) {
            omittedOptional.push({ id: item.id, name: item.name, reason: "budget" });
            omittedBudgetCount++;
            continue;
          }
          optionalBudgetRemaining -= size;
          remainingBudget -= size;
          includedOptionalCount++;
          add("Tracker attachment", text, {
            name: item.name,
            at: item.createdAt ?? "BB Tasks input",
            upload: false,
            required: false,
            createdAt: item.createdAt,
            id: item.id,
            maskedSha256: digest(masked),
          });
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }

  materials.omittedOptional = omittedOptional;
  materials.stats = {
    mandatory: mandatoryCount,
    includedOptional: includedOptionalCount,
    omittedBudget: omittedBudgetCount,
    omittedNotText: omittedNotTextCount,
    omittedDownloadFailed: omittedDownloadFailedCount,
  };
  return materials;
}

export async function collectTask(context, blocks, materials, options) {
  if (!Array.isArray(context.attachmentOmissions)) {
    context.attachmentOmissions = [];
  }
  const { signal, spillDir } = options;
  const { root, pin, settings } = context;
  const maxBytes = settings.maxTotalBytes;
  const revision = pin?.sha ?? "working copy";
  const isLightResearch = context.research && !context.write;
  const mask = isLightResearch ? (str) => settings.maskResearch(str, context.key) : settings.mask;
  const core = [], omitted = [], materialFiles = [];
  let coreBytes = 0;
  const add = (source, value, { name, at = revision, delivery = "package", included = "full", required = true, createdAt, id, path } = {}) => {
    const text = mask(value);
    const size = bytes(text);
    coreBytes += size;
    if (coreBytes > maxBytes) throw new Error("mandatory task context exceeds byte budget");
    const entry = { source, ...(name ? { name: mask(name) } : {}), ...(createdAt ? { createdAt } : {}), ...(id ? { id } : {}), ...(path ? { path } : {}), revision: at, required, included, bytes: size, sha256: digest(text), delivery };
    core.push(Object.freeze({ entry: Object.freeze(entry), text }));
  };
  const omit = (source, reason) => omitted.push({ source: mask(source), reason, revision });

  const mandatoryMaterials = materials.filter((m) => m.required !== false);
  const optionalMaterials = materials.filter((m) => m.required === false);

  add("Task text", context.text);
  for (const { source, text, name, at, upload, required = true, createdAt, id, resolvedPath } of mandatoryMaterials) {
    let delivery = "package";
    if (upload) {
      const { pkgName, pkgPath } = tools.writeSpillPackage(spillDir, randomUUID(), mask(text));
      options.ownedFiles.push(pkgPath);
      materialFiles.push(pkgPath);
      delivery = pkgName;
    }
    add(source, text, { name, at: at ?? (resolvedPath ? resolvedPath : revision), delivery, required, createdAt, id, path: resolvedPath });
  }

  const linkSourceText = isLightResearch ? buildCleanResearchPackage(context) : context.text;
  for (const link of explicitLinks({ ...context, text: linkSourceText }, isLightResearch ? [] : blocks)) {
    signal.throwIfAborted();
    add("Explicit link", link, { at: "task or ACP input", included: "reference" });
    const call = linkCall(link);
    if (!call) { omit(link, "unsupported URL; contents not read"); continue; }
    const result = await readBbMaterial(tools.bbReadCommand(call), mask, maxBytes, signal);
    if (!result.ok || result.truncated) throw new Error("mandatory linked BB material could not be collected in full");
    add("Linked BB material", result.output, { name: link, at: "BB output at collection" });
  }

  const fileBases = [];
  if (context.write) {
    for (const path of new Set([...(context.write.allowedPaths ?? []), ...context.repoFiles])) {
      signal.throwIfAborted();
      const info = await fileBaseInfo(context, path);
      if (info) fileBases.push({ path, ...info });
    }
  }
  let reviewDiff = null;
  if (root && !context.research) {
    if (!pin) {
      const status = await worktreeStatus(root, maxBytes, signal);
      add("Git status (index and worktree)", status.text);
      if (status.omitted) omit("Git status", "sensitive paths (" + status.omitted + ")");
    }
    for (const diff of await collectDiff(root, pin, maxBytes, signal)) {
      add(diff.source + " --stat", diff.stat);
      add(diff.source + " -U10", diff.patch);
      for (const entry of diff.excluded) omit(entry.source, entry.reason);
      if (pin) reviewDiff = Object.freeze({ stat: diff.stat, patch: diff.patch, excluded: diff.excluded });
    }
  } else if (!root) {
    omit("Git status and diff", "working directory is not a Git worktree");
  }

  const allOmittedOptional = [...(materials.omittedOptional ?? [])];
  for (const item of optionalMaterials) {
    const { source, text, name, at, upload, createdAt, id } = item;
    const maskedText = mask(text);
    const size = bytes(maskedText);
    if (coreBytes + size > maxBytes) {
      allOmittedOptional.push({ id, name, reason: "budget" });
      continue;
    }
    let delivery = "package";
    if (upload) {
      const { pkgName, pkgPath } = tools.writeSpillPackage(spillDir, randomUUID(), maskedText);
      options.ownedFiles.push(pkgPath);
      materialFiles.push(pkgPath);
      delivery = pkgName;
    }
    coreBytes += size;
    const entry = { source, ...(name ? { name: mask(name) } : {}), ...(createdAt ? { createdAt } : {}), ...(id ? { id } : {}), revision: at ?? revision, required: false, included: "full", bytes: size, sha256: digest(maskedText), delivery };
    core.push(Object.freeze({ entry: Object.freeze(entry), text: maskedText }));
  }

  if (!isLightResearch) {
    for (const item of (context.attachmentOmissions ?? [])) {
      omit("Tracker attachment: " + item.line, item.reason);
    }
    for (const item of allOmittedOptional) {
      omit("Tracker attachment: " + item.name, "optional attachment: " + item.reason);
    }
  }

  const skippedAttachmentsBlock = !isLightResearch && allOmittedOptional.length
    ? buildSkippedAttachmentsBlock(allOmittedOptional, mask)
    : "";
  return Object.freeze({ core: Object.freeze(core), omitted: Object.freeze(omitted.map(Object.freeze)),
    files: Object.freeze(materialFiles), reviewDiff, fileBases, skippedAttachmentsBlock, allOmittedOptional });
}

export function filterServiceLines(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const result = [];
  let inGit = false;
  for (const line of lines) {
    if (inGit) {
      if (line.trim() === "") {
        inGit = false;
      }
      continue;
    }
    if (/^\s*(?:Работа с git|Git work):/.test(line)) {
      inGit = true;
      continue;
    }
    if (/^\s*(?:задача без кода|no-code task)/i.test(line)) continue;
    if (/^\s*(?:Проверяемый итог: коммит|Result under review: commit)/i.test(line)) continue;
    if (/^\s*(?:Приложенные файлы \(прочитай в репозитории\)|Attached files \(read them in the repo\))/i.test(line)) continue;
    result.push(line);
  }
  while (result.length && result[0].trim() === "") result.shift();
  while (result.length && result[result.length - 1].trim() === "") result.pop();
  return result.join("\n");
}

export function buildCleanResearchPackage(context, { isFirstTurn = true } = {}) {
  const text = context.text ?? "";
  const mask = (str) => context.settings?.maskResearch ? context.settings.maskResearch(str, context.key) : str;

  const lines = text.split(/\r?\n/);
  const firstNonEmpty = lines.find((l) => l.trim() !== "");
  const hasTaskHeader = firstNonEmpty ? /^#\s+[A-Z][A-Z0-9]{1,9}-\d+\s+·\s+/.test(firstNonEmpty) : false;
  const descIdx = lines.findIndex((l) => l.replace(/[ \t\r]+$/, "") === "## Description");
  const isBbTemplate = hasTaskHeader && descIdx !== -1;

  if (!isBbTemplate) {
    const filtered = filterServiceLines(text);
    return mask(filtered);
  }

  if (!isFirstTurn) {
    const filtered = filterServiceLines(text);
    return mask(filtered);
  }

  const SERVICE_HEADINGS_SET = new Set(BB_SERVICE_HEADINGS);
  const isServiceHeading = (line) => SERVICE_HEADINGS_SET.has(line.replace(/[ \t\r]+$/, ""));
  let firstServiceIdx = lines.findIndex((l, idx) => idx > descIdx && isServiceHeading(l));
  if (firstServiceIdx === -1) firstServiceIdx = lines.length;

  const descText = lines.slice(descIdx + 1, firstServiceIdx).join("\n").trim();

  const reportBackIdx = lines.findLastIndex((l) => l.replace(/[ \t\r]+$/, "") === "## Report-back contract");
  const isAfterBoundary = (idx) => (reportBackIdx !== -1 ? idx > reportBackIdx : idx >= firstServiceIdx);

  let addText = "";
  const addIdx = lines.findLastIndex((l, idx) => isAfterBoundary(idx) && l.replace(/[ \t\r]+$/, "") === "## Additional instructions");
  if (addIdx !== -1) {
    const nextIdx = lines.findIndex((l, idx) => idx > addIdx && isServiceHeading(l));
    const rawAdd = lines.slice(addIdx + 1, nextIdx === -1 ? undefined : nextIdx).join("\n");
    addText = filterServiceLines(rawAdd);
  }

  let presetText = "";
  const presetLimit = addIdx !== -1 ? addIdx : lines.length;
  const presetIdx = lines.findLastIndex((l, idx) => isAfterBoundary(idx) && idx < presetLimit && l.replace(/[ \t\r]+$/, "") === "## Preset instructions");
  if (presetIdx !== -1) {
    const nextIdx = lines.findIndex((l, idx) => idx > presetIdx && isServiceHeading(l));
    const rawPreset = lines.slice(presetIdx + 1, nextIdx === -1 ? undefined : nextIdx).join("\n");
    presetText = filterServiceLines(rawPreset);
  }

  const parts = [
    firstNonEmpty,
    descText,
    presetText,
    addText,
  ].filter(Boolean);

  return mask(parts.join("\n\n"));
}

function renderTaskPackage(context, collected, options, supplements, agentOmissions, compact = false) {
  const { limit, spillDir } = options;
  const pin = context.pin;
  const repo = Boolean(pin || context.root);
  // PLUG-404: чистый research-пакет без шапки инструментов, протокола и описи.
  const light = context.research && !context.write;

  if (light) {
    const isFirstTurn = options.isFirstTurn !== false;
    const taskBody = buildCleanResearchPackage(context, { isFirstTurn });
    const extraCore = (collected.core ?? [])
      .filter(({ entry }) => entry?.source === "Embedded resource" && entry?.delivery === "package")
      .map(({ text }) => text);
    const body = [taskBody, ...extraCore].filter(Boolean).join("\n\n");
    const header = isFirstTurn ? SEARCH_DIRECTIVE : "";
    const { message, payload, spilledFile } = tools.packFirstMessage({
      maxBytes: limit,
      spillDir,
      spillId: randomUUID(),
      completePackage: {
        header,
        manifest: false,
        render: () => body,
      },
    });
    const totalBytes = bytes(message) + (spilledFile ? bytes(payload) : 0) +
      (collected.core ?? []).filter(({ entry }) => entry?.delivery !== "package").reduce((total, { entry }) => total + (entry?.bytes ?? 0), 0);
    if (bytes(message) > limit || totalBytes + (options.reserveBytes ?? 0) > context.settings.maxTotalBytes) {
      if (spilledFile) rmSync(spilledFile, { force: true });
      throw new Error("mandatory task context exceeds delivery budget");
    }
    if (spilledFile) options.ownedFiles?.push(spilledFile);
    return {
      message,
      files: Object.freeze([...(collected.files ?? []), ...(spilledFile ? [spilledFile] : [])]),
      packageSha256: digest(payload),
      totalBytes,
    };
  }

  const header = [
    tools.toolSystemHeader(undefined, { pinned: Boolean(pin), repo }),
    pin ? "All repository tools use the pinned review tree: " + pin.sha : "",
    taskInstruction(context),
  ].filter(Boolean).join("\n\n");
  const tables = (delivery) => {
    let offset = 0;
    let body = "";
    const append = (entry, text) => {
      if (entry.delivery !== "package") return { ...entry, range: [0, entry.bytes] };
      const dateSuffix = entry.source === "Tracker attachment" && entry.createdAt ? ` (${entry.createdAt})` : "";
      const pathSuffix = entry.source === "orchestrator-data" && (entry.path || entry.revision) ? ` (${entry.path || entry.revision})` : "";
      const heading = "=== " + entry.source + (entry.name ? ": " + JSON.stringify(entry.name) : "") + dateSuffix + pathSuffix + " ===\n";
      const start = offset + bytes(heading);
      body += heading + text + "\n\n";
      offset = start + entry.bytes + 2;
      return { ...entry, delivery, range: [start, start + entry.bytes] };
    };
    const included = collected.core.map(({ entry, text }) => append(entry, text));
    if (collected.skippedAttachmentsBlock) {
      body += collected.skippedAttachmentsBlock + "\n\n";
      offset += bytes(collected.skippedAttachmentsBlock + "\n\n");
    }
    if (supplements.length) {
      const heading = "=== Дополнения быстрого агента / Fast agent additions ===\n";
      body += heading;
      offset += bytes(heading);
    }
    const added = supplements.map(({ text, partial, ...item }) => append({
      ...item, delivery: "package", required: false, included: partial ? "partial" : "full",
      bytes: bytes(text), sha256: digest(text),
    }, text));
    const manifest = {
      version: 1,
      revision: pin?.sha ?? "working copy",
      ...(pin ? { mergeBase: pin.base } : {}),
      permissions: context.write ? "write" : "read-only",
      expected: context.write ? "files" : context.verdict ? "verdict" : "text",
      ...(context.write ? { writeBase: context.writeHead.sha, fileBases: collected.fileBases } : {}),
      taskSha256: included[0].sha256,
      coreSha256: digest(JSON.stringify(collected.core.map(({ entry: { delivery, ...item } }) => item))),
      rangeUnits: "half-open UTF-8 byte offsets from the start of the package body or attachment",
      included, ...(added.length ? { supplements: added } : {}),
      omitted: [...collected.omitted, ...agentOmissions],
    };
    const summary = "проверяемый коммит: " + (pin?.sha ?? "не указан, упакована рабочая копия");
    return body + "=== Опись / Manifest ===\n" + summary + "\n" + JSON.stringify(manifest, null, compact ? 0 : 2) + "\n";
  };
  const { message, payload, spilledFile } = tools.packFirstMessage({
    maxBytes: limit, spillDir, spillId: randomUUID(), completePackage: { header, render: tables },
  });
  const totalBytes = bytes(message) + (spilledFile ? bytes(payload) : 0) +
    collected.core.filter(({ entry }) => entry.delivery !== "package").reduce((total, { entry }) => total + entry.bytes, 0);
  if (bytes(message) > limit || totalBytes + (options.reserveBytes ?? 0) > context.settings.maxTotalBytes) {
    if (spilledFile) rmSync(spilledFile, { force: true });
    throw new Error("mandatory task and manifest exceed delivery budget");
  }
  if (spilledFile) options.ownedFiles.push(spilledFile);
  return { message, files: Object.freeze([...collected.files, ...(spilledFile ? [spilledFile] : [])]),
    packageSha256: digest(payload), totalBytes };
}

export function packTask(context, collected, options) {
  const light = context.research && !context.write;
  if (light) {
    return Object.freeze({
      ...renderTaskPackage(context, collected, options, [], []),
      agentDeliveryLimited: false,
    });
  }
  const supplements = [...(collected.agent?.supplements ?? [])];
  let omissions = collected.agent?.omitted ?? [];
  let dropped = 0, compact = false, summarized = false;
  let currentCollected = collected;
  while (true) {
    const budgetNote = dropped ? [{
      source: "Fast agent", revision: context.pin?.sha ?? "working copy",
      reason: "delivery budget excluded " + dropped + " additional result(s)",
    }] : [];
    try {
      return Object.freeze({
        ...renderTaskPackage(context, currentCollected, options, supplements, [...omissions, ...budgetNote], compact),
        agentDeliveryLimited: dropped > 0 || compact,
      });
    } catch (error) {
      if (supplements.length) {
        supplements.pop();
        dropped++;
      } else {
        const optionalIdx = currentCollected.core.findLastIndex(({ entry }) => entry.required === false);
        if (optionalIdx !== -1) {
          const removed = currentCollected.core[optionalIdx];
          const newCore = currentCollected.core.filter((_, idx) => idx !== optionalIdx);
          const newOmitted = [
            ...currentCollected.omitted,
            {
              source: context.settings.mask("Tracker attachment: " + (removed.entry.name ?? "unnamed")),
              reason: "optional attachment: budget",
              revision: removed.entry.revision ?? "working copy",
            },
          ];
          const omittedEntry = { id: removed.entry.id, name: removed.entry.name, reason: "budget" };
          const allOmitted = [...(currentCollected.allOmittedOptional ?? []), omittedEntry];
          const newSkippedBlock = buildSkippedAttachmentsBlock(allOmitted, context.settings.mask);
          currentCollected = {
            ...currentCollected,
            core: Object.freeze(newCore),
            omitted: Object.freeze(newOmitted),
            skippedAttachmentsBlock: newSkippedBlock,
            allOmittedOptional: allOmitted,
          };
        } else if (!compact && (omissions.length || dropped)) {
          compact = true;
        } else if (!summarized && omissions.length > 1) {
          omissions = [{ source: "Fast agent", reason: "additional context incomplete; omission details exceed delivery budget" }];
          summarized = true;
        } else if (omissions.length || dropped) {
          // The mandatory package can exactly fill the remaining space.
          return Object.freeze({ ...renderTaskPackage(context, currentCollected, options, [], []), agentDeliveryLimited: true });
        } else {
          throw error;
        }
      }
    }
  }
}

export async function taskTool(context, collected, call, limit, signal) {
  const mask = context.settings.mask;
  const bbRead = tools.bbReadCommand(call);
  if (bbRead) return readBbMaterial(bbRead, mask, limit, signal);
  // PLUG-384: в публичном research шапка инструменты дерева не объявляет —
  // их вызов получает явный отказ, а не чтение локальных файлов.
  if (context.research && !context.write && ["read_file", "list_dir", "grep", "git"].includes(call.name)) {
    return { ok: false, output: "error: repository tools are unavailable in a public research task" };
  }
  const options = { cwd: context.root ?? context.cwd, mask, maxResultBytes: limit, rejectSensitive: true };
  if (!context.pin || !["read_file", "list_dir", "grep", "git"].includes(call.name)) {
    const result = await tools.executeTool(call, options);
    const base = result.ok && call.name === "read_file" ? await fileBaseInfo(context, call.args.path) : null;
    return base ? { ...result, base } : result;
  }
  try {
    const { output, range, partial, excluded } = await executePinned(call, context.root, context.pin, collected.reviewDiff, context.settings.maxTotalBytes, signal);
    return { ok: true, range, ...tools.limitResult(mask(output), limit),
      ...(partial ? { partial } : {}),
      ...(excluded ? { excluded: excluded.map(({ source, reason }) => ({ source: mask(source), reason: mask(reason) })) } : {}),
    };
  } catch {
    return { ok: false, output: "error: request denied or unavailable in the pinned review tree" };
  }
}

async function readBbMaterial(command, mask, limit, signal) {
  if (command?.error) return { ok: false, output: "error: invalid BB read arguments" };
  try {
    const text = await bb(command.argv, signal);
    return { ok: true, ...tools.limitResult(mask(text), limit) };
  } catch {
    return { ok: false, output: "error: linked BB material is unavailable" };
  }
}

export function formatTaskToolResult(context, call, result) {
  const repositoryTool = ["read_file", "list_dir", "grep", "git"].includes(call.name);
  const manifest = {
    revision: repositoryTool ? context.pin?.sha ?? "working copy" : "BB output at collection",
    source: context.settings.mask(tools.callArgsString(call)),
    range: result.range ?? null,
    truncated: result.truncated ?? null,
    bytes: bytes(result.output),
    sha256: digest(result.output),
    ...(result.partial ? { partial: true } : {}),
    ...(result.excluded ? { excluded: result.excluded } : {}),
    ...(result.base ? { fileBase: result.base } : {}),
  };
  return ["=== tool: " + context.settings.mask(call.name) + " ===", JSON.stringify(manifest), result.output].join("\n");
}

export const taskInputSha256 = (inputBlocksSha256, materials, mask = (t) => t) => {
  const mandatory = [];
  const includedOptional = [];
  for (const m of materials || []) {
    const textHash = m.maskedSha256 ?? digest(mask(m.text));
    if (m.required !== false) {
      mandatory.push({
        source: m.source,
        idOrPath: m.source === "orchestrator-data" ? (m.resolvedPath ?? m.at ?? m.name) : (m.id ?? m.name ?? m.at),
        sha256: textHash,
      });
    } else {
      includedOptional.push({
        id: m.id,
        sha256: textHash,
      });
    }
  }
  const omittedOptional = (materials?.omittedOptional || []).map((o) => ({
    id: o.id,
    reason: o.reason,
  }));
  return digest(JSON.stringify([
    inputBlocksSha256,
    mandatory,
    includedOptional,
    omittedOptional,
  ]));
};

export const taskMandatorySha256 = (inputBlocksSha256, materials, mask = (t) => t) => {
  const mandatory = [];
  for (const m of materials || []) {
    const textHash = m.maskedSha256 ?? digest(mask(m.text));
    if (m.required !== false) {
      mandatory.push({
        source: m.source,
        idOrPath: m.source === "orchestrator-data" ? (m.resolvedPath ?? m.at ?? m.name) : (m.id ?? m.name ?? m.at),
        sha256: textHash,
      });
    }
  }
  return digest(JSON.stringify([
    inputBlocksSha256,
    mandatory,
  ]));
};
