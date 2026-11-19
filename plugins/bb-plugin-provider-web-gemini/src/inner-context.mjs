import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as tools from "./web-tools.mjs";
import { collectDiff, executePinned, pinReview, readMaterial, readTextFile, repoRoot, worktreeStatus } from "./review-git.mjs";

const runFile = promisify(execFile);
const DEFAULT_TOTAL = 25_000_000;
const REVIEW_LINE = /^(?:Проверяемый итог: коммит|Result under review: commit)[ \t]+(\S+)(?:[ \t]+\([^)]*\))?[ \t]*$/;
const REVIEW_PREFIX = /^(?:Проверяемый итог: коммит|Result under review: commit)(?:\s|$)/;
const ATTACHED_PATHS = /^(?:Приложенные файлы \(прочитай в репозитории\)|Attached files \(read them in the repo\)):[ \t]*(.+)$/;
const AUDITOR = /(?:^|\n)[ \t]*(?:[-*][ \t]+)?(?:Заканчивай отчёт строкой JSON|End the report with the JSON line)[ \t]+\{"verdict":"OK"\|"CHANGES","blockers":<[^>\n]+>\}/;
const FILE_ATTACHMENT_ID = "[0-9A-HJKMNP-TV-Z]{26}";
const TRACKER_ATTACHMENT = new RegExp("^- (.+) · (" + FILE_ATTACHMENT_ID + ")$");
const THREAD_TOKEN = new RegExp("\\b" + tools.THREAD_ID_RE.source.slice(1, -1) + "\\b", "gi");
const TASK_TOKEN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b(?!\s*(?:charset|encoding))/g;
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
  if (!record(input) || ["context", "apply", "innerAgent"].some((key) => input[key] !== undefined && !record(input[key]))) {
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
    maxTotalBytes: setting(input.context?.maxTotalBytes, DEFAULT_TOTAL, 1, "context.maxTotalBytes"),
    maxRepairRounds: setting(input.apply?.maxRepairRounds, 2, 0, "apply.maxRepairRounds"),
    progressIntervalMs: setting(input.progressIntervalMs, 15_000, 1, "progressIntervalMs"),
    mask(text) {
      let value = String(text);
      for (const { type, re } of compiled) value = value.replace(re, () => "[скрыто: " + type + "]");
      return tools.maskForWeb(value)
        .replace(/(\b(?:https?|ftp):\/\/)[^\s/@]+(?=@)/gi, "$1[скрыто: credentials]")
        .replace(THREAD_TOKEN, "[скрыто: bb-thread-id]")
        .replace(TASK_TOKEN, (token) => tools.isTaskKeyToken(token) ? "[скрыто: task-key]" : token);
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

export async function prepareTask({ text, system, session, thread, stateDir, signal, onSettings }) {
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
  const pin = await pinReview(root, refs, thread.environment ?? {}, signal);
  const verdict = parseVerdict(text, system, pin);
  const attachments = section(text, /^## Attachments[ \t]*$/)
    .filter((line) => line.startsWith("- ")).map((line) => {
      const match = TRACKER_ATTACHMENT.exec(line);
      if (!match) throw new Error("malformed tracker attachment entry");
      return { name: match[1], id: match[2] };
    });
  const key = /^# ([A-Z][A-Z0-9]{1,9}-\d+) · /m.exec(text)?.[1];
  return { text, settings, verdict, cwd, root, pin, repoFiles, attachments, key, thread: thread.thread };
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

function finalLine(text) {
  return String(text).match(/(?:^|\n)([^\n]*\S[^\n]*)(?:\r?\n[ \t\r]*)*$/)?.[1]?.replace(/\r$/, "") ?? "";
}

export function checkedAnswer(context, response) {
  const page = String(response?.text ?? response ?? "");
  const raw = typeof response?.rawText === "string" && response.rawText.trim() ? response.rawText : null;
  const source = raw ?? page;
  const isFileEnvelope = (text) => /"format"\s*:\s*"web-gemini-files-v1"/.test(text);
  if (isFileEnvelope(source) || isFileEnvelope(page) || response?.files?.length || response?.hasGeneratedFile) {
    return { denied: "file output requires a write-enabled preset and a dedicated worktree; full grants read-only access" };
  }
  if (!source.trim() || tools.parseToolCalls(source).length || tools.parseToolCalls(page).length ||
      /<tool\b/i.test(source) || /<tool\b/i.test(page)) return { repair: "empty or unfinished tool response" };
  if (context.settings.mask(source) !== source || context.settings.mask(page) !== page) {
    return { repair: "response contains material prohibited for publication" };
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

export async function collectTask(context, blocks, options) {
  const { signal, maxUploadBytes, maxUploadCount, validateUploads, spillDir } = options;
  const { root, pin, settings } = context;
  const maxBytes = settings.maxTotalBytes;
  const revision = pin?.sha ?? "working copy";
  const mask = settings.mask;
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
  const upload = (name, text, source, at) => {
    if (materialFiles.length >= maxUploadCount || bytes(text) > maxUploadBytes || bytes(mask(text)) > maxUploadBytes) {
      throw new Error("mandatory attachment exceeds upload count or size limit");
    }
    const { pkgName, pkgPath } = tools.writeSpillPackage(spillDir, randomUUID(), mask(text));
    options.ownedFiles.push(pkgPath);
    materialFiles.push(pkgPath);
    add(source, text, { name, at, delivery: pkgName });
  };

  add("Task text", context.text);
  for (const block of blocks) {
    signal.throwIfAborted();
    if (block.type === "resource") {
      const uri = String(block.resource?.uri ?? "embedded resource");
      const name = uri.startsWith("file:") ? basename(uri) : uri;
      if (typeof block.resource?.text !== "string" || /^(?:image|audio|video)\//i.test(block.resource?.mimeType ?? "")) {
        omit("Embedded resource", "binary or unavailable");
        throw new Error("mandatory embedded resource is not text");
      }
      add("Embedded resource", block.resource.text, { name, at: "ACP input" });
    }
  }
  for (const file of new Set(context.repoFiles)) {
    try {
      add("Repository attachment", await readMaterial(root ?? context.cwd, pin, file, maxBytes, signal), { name: file });
    } catch {
      omit("Repository attachment", "unavailable, sensitive, non-text or above context budget");
      throw new Error("mandatory repository attachment could not be collected");
    }
  }

  const externalBlocks = [];
  const seenPaths = new Set();
  for (const block of blocks) {
    const file = blockFile(block);
    if (["image", "audio", "localImage"].includes(block.type) || /^(?:image|audio|video)\//i.test(block.mimeType ?? "")) {
      omit("ACP attachment", "binary");
      throw new Error("mandatory attachment is binary");
    }
    if (!file) continue;
    const abs = resolve(context.cwd, file);
    const repoFile = root && inside(root, abs);
    if (seenPaths.has(abs)) continue;
    seenPaths.add(abs);
    if (pin && repoFile) {
      upload(repoFile, await readMaterial(root, pin, repoFile, maxUploadBytes, signal), "Repository attachment", pin.sha);
    } else {
      externalBlocks.push(block);
    }
  }
  if (externalBlocks.length) {
    const result = validateUploads(externalBlocks);
    if (result.error) throw new Error("mandatory ACP attachment is inaccessible or exceeds upload limits");
    for (const file of result.files) upload(basename(file), await readTextFile(file, maxUploadBytes, signal), "ACP attachment", "ACP input");
  }
  if (context.attachments.length) {
    if (materialFiles.length + new Set(context.attachments.map((item) => item.id)).size > maxUploadCount) {
      throw new Error("mandatory attachments exceed upload count");
    }
    mkdirSync(spillDir, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(spillDir, "tracker-"));
    try {
      for (const file of await trackerFiles(context, scratch, maxUploadBytes, signal)) {
        upload(file.name, file.text, "Tracker attachment", "BB Tasks input");
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  for (const link of explicitLinks(context, blocks)) {
    signal.throwIfAborted();
    add("Explicit link", link, { at: "task or ACP input", included: "reference" });
    const call = linkCall(link);
    if (!call) { omit(link, "unsupported URL; contents not read"); continue; }
    const result = await readBbMaterial(tools.bbReadCommand(call), mask, maxBytes, signal);
    if (!result.ok || result.truncated) throw new Error("mandatory linked BB material could not be collected in full");
    add("Linked BB material", result.output, { name: link, at: "BB output at collection" });
  }

  let reviewDiff = null;
  if (root) {
    if (!pin) {
      const status = await worktreeStatus(root, maxBytes, signal);
      add("Git status (index and worktree)", status.text);
      if (status.omitted) omit("Git status", "sensitive paths (" + status.omitted + ")");
    }
    for (const diff of await collectDiff(root, pin, maxBytes, signal)) {
      add(diff.source + " --stat", diff.stat);
      add(diff.source + " -U10", diff.patch);
      for (const entry of diff.excluded) omit(entry.source, entry.reason);
      if (pin) reviewDiff = Object.freeze({ stat: diff.stat, patch: diff.patch });
    }
  } else {
    omit("Git status and diff", "working directory is not a Git worktree");
  }
  return Object.freeze({ core: Object.freeze(core), omitted: Object.freeze(omitted.map(Object.freeze)), files: Object.freeze(materialFiles), reviewDiff });
}

export function packTask(context, collected, options) {
  const { limit, spillDir } = options;
  const pin = context.pin;
  const header = [
    tools.toolSystemHeader(undefined, { pinned: Boolean(pin) }),
    pin ? "All repository tools use the pinned review tree: " + pin.sha : "",
    verdictInstruction(context),
  ].filter(Boolean).join("\n\n");
  const tables = (delivery) => {
    let offset = 0;
    let body = "";
    const included = collected.core.map(({ entry, text }) => {
      if (entry.delivery !== "package") return { ...entry, range: [0, entry.bytes] };
      const heading = "=== " + entry.source + (entry.name ? ": " + JSON.stringify(entry.name) : "") + " ===\n";
      const start = offset + bytes(heading);
      body += heading + text + "\n\n";
      offset = start + entry.bytes + 2;
      return { ...entry, delivery, range: [start, start + entry.bytes] };
    });
    const manifest = {
      version: 1,
      revision: pin?.sha ?? "working copy",
      ...(pin ? { mergeBase: pin.base } : {}),
      permissions: "read-only",
      expected: context.verdict ? "verdict" : "text",
      taskSha256: included[0].sha256,
      coreSha256: digest(JSON.stringify(collected.core.map(({ entry: { delivery, ...item } }) => item))),
      rangeUnits: "half-open UTF-8 byte offsets from the start of the package body or attachment",
      included, omitted: collected.omitted,
    };
    const summary = "проверяемый коммит: " + (pin?.sha ?? "не указан, упакована рабочая копия");
    return body + "=== Опись / Manifest ===\n" + summary + "\n" + JSON.stringify(manifest, null, 2) + "\n";
  };
  const { message, payload, spilledFile } = tools.packFirstMessage({
    maxBytes: limit, spillDir, spillId: randomUUID(), completePackage: { header, render: tables },
  });
  if (spilledFile) options.ownedFiles.push(spilledFile);
  const totalBytes = bytes(message) + (spilledFile ? bytes(payload) : 0) +
    collected.core.filter(({ entry }) => entry.delivery !== "package").reduce((total, { entry }) => total + entry.bytes, 0);
  if (bytes(message) > limit || totalBytes > context.settings.maxTotalBytes) throw new Error("mandatory task and manifest exceed delivery budget");
  return Object.freeze({ message, files: Object.freeze([...collected.files, ...(spilledFile ? [spilledFile] : [])]),
    packageSha256: digest(payload), totalBytes });
}

export async function taskTool(context, collected, call, limit, signal) {
  const mask = context.settings.mask;
  const bbRead = tools.bbReadCommand(call);
  if (bbRead) return readBbMaterial(bbRead, mask, limit, signal);
  const options = { cwd: context.root ?? context.cwd, mask, maxResultBytes: limit, rejectSensitive: true };
  if (!context.pin || !["read_file", "list_dir", "grep", "git"].includes(call.name)) {
    return tools.executeTool(call, options);
  }
  try {
    const { output, range } = await executePinned(call, context.root, context.pin, collected.reviewDiff, context.settings.maxTotalBytes, signal);
    return { ok: true, range, ...tools.limitResult(mask(output), limit) };
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
  };
  return ["=== tool: " + context.settings.mask(call.name) + " ===", JSON.stringify(manifest), result.output].join("\n");
}
