import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as tools from "./web-tools.mjs";
import { agentSettings } from "./fast-agent.mjs";
import { collectDiff, executePinned, pinReview, readMaterial, readTextFile, repoRoot, worktreeStatus } from "./review-git.mjs";
import { deserializeVerdict } from "./turn-journal.mjs";

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
  return Object.freeze({
    innerAgent: agentSettings(input.innerAgent, setting),
    maxTotalBytes: setting(input.context?.maxTotalBytes, DEFAULT_TOTAL, 1, "context.maxTotalBytes"),
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
  if (!research) {
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
  }
  return { text, settings, verdict, cwd, root, pin, repoFiles, attachments, attachmentOmissions, key, thread: thread.thread, research };
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

async function trackerFiles(context, scratch, maxBytes, signal) {
  if (!context.key) throw new Error("tracker attachments require a task key");
  const shown = JSON.parse(await bb(["tasks", "show", context.key, "--json"], signal));
  if (shown.task?.key !== context.key || shown.project?.linkedBbProjectId !== context.thread.projectId ||
      !shown.taskThreads?.some((entry) => entry.threadId === context.thread.id)) {
    throw new Error("tracker attachment task does not match the current BB thread");
  }
  const output = [];
  const seen = new Set();
  for (const file of context.attachments) {
    const entry = shown.attachments?.find((item) => item.id === file.id);
    if (!entry || (Number.isFinite(entry.sizeBytes) && entry.sizeBytes > maxBytes)) throw new Error("tracker attachment unavailable or too large");
    if (seen.has(file.id)) continue;
    seen.add(file.id);
    const dest = join(scratch, randomUUID());
    try {
      await bb(["tasks", "attachment", "get", file.id, "--out", dest], signal);
      output.push({ name: entry.fileName ?? file.name, text: await readTextFile(dest, maxBytes, signal) });
    } catch {
      throw new Error("tracker attachment could not be downloaded as permitted text");
    }
  }
  return output;
}

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
  const add = (source, text, { name, at, upload = false }) => {
    const size = bytes(mask(text));
    if (upload && (++uploadCount > maxUploadCount || bytes(text) > maxUploadBytes || size > maxUploadBytes)) {
      throw new Error("mandatory attachment exceeds upload count or size limit");
    }
    materialBytes += size;
    if (materialBytes > maxBytes) throw new Error("mandatory task context exceeds byte budget");
    materials.push({ source, text, name, at, upload });
  };
  for (const block of blocks) {
    signal.throwIfAborted();
    if (block.type === "resource") {
      const uri = String(block.resource?.uri ?? "embedded resource");
      const name = uri.startsWith("file:") ? basename(uri) : uri;
      if (typeof block.resource?.text !== "string" || /^(?:image|audio|video)\//i.test(block.resource?.mimeType ?? "")) {
        throw new Error("mandatory embedded resource is not text");
      }
      add("Embedded resource", block.resource.text, { name, at: "ACP input" });
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
      add("Repository attachment", await readMaterial(root ?? context.cwd, pin, file, maxBytes, signal), { name: file });
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
        name: repoFile, at: pin.sha, upload: true,
      });
    } else {
      externalBlocks.push(block);
    }
  }
  if (externalBlocks.length) {
    const result = validateUploads(externalBlocks);
    if (result.error) throw new Error("mandatory ACP attachment is inaccessible or exceeds upload limits");
    for (const file of result.files) {
      add("ACP attachment", await readTextFile(file, maxUploadBytes, signal), {
        name: basename(file), at: "ACP input", upload: true,
      });
    }
  }
  if (!light && context.attachments?.length) {
    if (uploadCount + new Set(context.attachments.map((item) => item.id)).size > maxUploadCount) {
      throw new Error("mandatory attachments exceed upload count");
    }
    mkdirSync(spillDir, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(spillDir, "tracker-"));
    try {
      for (const file of await trackerFiles(context, scratch, maxUploadBytes, signal)) {
        add("Tracker attachment", file.text, { name: file.name, at: "BB Tasks input", upload: true });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return materials;
}

export async function collectTask(context, blocks, materials, options) {
  const { signal, spillDir } = options;
  const { root, pin, settings } = context;
  const maxBytes = settings.maxTotalBytes;
  const revision = pin?.sha ?? "working copy";
  const isLightResearch = context.research && !context.write;
  const mask = isLightResearch ? (str) => settings.maskResearch(str, context.key) : settings.mask;
  const core = [], omitted = [], materialFiles = [];
  let coreBytes = 0;
  const add = (source, value, { name, at = revision, delivery = "package", included = "full" } = {}) => {
    const text = mask(value);
    const size = bytes(text);
    coreBytes += size;
    if (coreBytes > maxBytes) throw new Error("mandatory task context exceeds byte budget");
    const entry = { source, ...(name ? { name: mask(name) } : {}), revision: at, required: true, included, bytes: size, sha256: digest(text), delivery };
    core.push(Object.freeze({ entry: Object.freeze(entry), text }));
  };
  const omit = (source, reason) => omitted.push({ source: mask(source), reason, revision });

  add("Task text", context.text);
  for (const { source, text, name, at, upload } of materials) {
    let delivery = "package";
    if (upload) {
      const { pkgName, pkgPath } = tools.writeSpillPackage(spillDir, randomUUID(), mask(text));
      options.ownedFiles.push(pkgPath);
      materialFiles.push(pkgPath);
      delivery = pkgName;
    }
    add(source, text, { name, at, delivery });
  }
  for (const item of context.attachmentOmissions) {
    omit("Tracker attachment: " + item.line, item.reason);
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
  return Object.freeze({ core: Object.freeze(core), omitted: Object.freeze(omitted.map(Object.freeze)),
    files: Object.freeze(materialFiles), reviewDiff, fileBases });
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

  let addText = "";
  const addIdx = lines.findLastIndex((l, idx) => idx >= firstServiceIdx && l.replace(/[ \t\r]+$/, "") === "## Additional instructions");
  if (addIdx !== -1) {
    const nextIdx = lines.findIndex((l, idx) => idx > addIdx && isServiceHeading(l));
    const rawAdd = lines.slice(addIdx + 1, nextIdx === -1 ? undefined : nextIdx).join("\n");
    addText = filterServiceLines(rawAdd);
  }

  let presetText = "";
  const presetLimit = addIdx !== -1 ? addIdx : lines.length;
  const presetIdx = lines.findLastIndex((l, idx) => idx >= firstServiceIdx && idx < presetLimit && l.replace(/[ \t\r]+$/, "") === "## Preset instructions");
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
      const heading = "=== " + entry.source + (entry.name ? ": " + JSON.stringify(entry.name) : "") + " ===\n";
      const start = offset + bytes(heading);
      body += heading + text + "\n\n";
      offset = start + entry.bytes + 2;
      return { ...entry, delivery, range: [start, start + entry.bytes] };
    };
    const included = collected.core.map(({ entry, text }) => append(entry, text));
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
  while (true) {
    const budgetNote = dropped ? [{
      source: "Fast agent", revision: context.pin?.sha ?? "working copy",
      reason: "delivery budget excluded " + dropped + " additional result(s)",
    }] : [];
    try {
      return Object.freeze({
        ...renderTaskPackage(context, collected, options, supplements, [...omissions, ...budgetNote], compact),
        agentDeliveryLimited: dropped > 0 || compact,
      });
    } catch (error) {
      if (supplements.length) {
        supplements.pop();
        dropped++;
      } else if (!compact && (omissions.length || dropped)) {
        compact = true;
      } else if (!summarized && omissions.length > 1) {
        omissions = [{ source: "Fast agent", reason: "additional context incomplete; omission details exceed delivery budget" }];
        summarized = true;
      } else if (omissions.length || dropped) {
        // The mandatory package can exactly fill the remaining space.
        return Object.freeze({ ...renderTaskPackage(context, collected, options, [], []), agentDeliveryLimited: true });
      } else {
        throw error;
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
