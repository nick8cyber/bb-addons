const { createHash } = require("node:crypto");

const FORMAT = "web-gemini-files-v2";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unicode = (value) => typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value);
const hasCoauthor = (value) => /^[ \t]*co-authored-by[ \t]*:/im.test(value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
// PLUG-351: repair/recapture text stays the verbatim model-facing reason,
// the stable code feeds the first-response counter in the turn journal.
const fail = (code, message) => Object.assign(new Error(message), { code });

// Rewrites observed in the saved hNvQHb history channel: the DOM channel keeps
// what the model emitted, history delivers the replacement. A channel match
// under a known rewrite names the literal cause the repair request must quote.
const HISTORY_REWRITES = [["\\|", "|"]];

function uniqueKeys(json) {
  // JSON.parse has already validated the grammar. Ignore punctuation in strings
  // and check decoded keys in the containing object, including escaped aliases.
  const stack = [];
  for (const match of json.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === "{" || token === "[") stack.push(token === "{" ? new Set() : null);
    else if (token === "}" || token === "]") stack.pop();
    else if (/^[ \r\n\t]*:/.test(json.slice(match.index + token.length))) {
      const keys = stack.at(-1);
      const key = JSON.parse(token);
      if (keys.has(key)) return false;
      keys.add(key);
    }
  }
  return true;
}

function metaFields(json, nonce) {
  let parsed;
  try { parsed = JSON.parse(json); }
  catch (error) {
    const position = /\bposition (\d+)/.exec(error.message)?.[1];
    throw fail("meta-json", "file response META is not one valid JSON line" + (position ? " near character " + position : ""));
  }
  if (!hasKeys(parsed, ["format", "nonce", "files", "commitMessage"]) || parsed.format !== FORMAT ||
      !Array.isArray(parsed.files) || !parsed.files.length || !unicode(parsed.commitMessage) ||
      !parsed.commitMessage.trim() || parsed.commitMessage.includes("\0") ||
      hasCoauthor(parsed.commitMessage) || !uniqueKeys(json)) {
    throw fail("meta-fields", "invalid file envelope META fields or commit message");
  }
  if (parsed.nonce !== nonce) throw fail("nonce", "file response has the wrong nonce");
  const paths = new Set();
  const files = parsed.files.map((file) => {
    if (!hasKeys(file, ["path", "operation", "baseSha256"]) || !unicode(file.path) || !file.path ||
        paths.has(file.path) || !["create", "replace", "delete"].includes(file.operation) ||
        (file.operation === "create" ? file.baseSha256 !== null :
          typeof file.baseSha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.baseSha256))) {
      throw fail("meta-entry", "invalid file entry or duplicate path in META");
    }
    paths.add(file.path);
    return { path: file.path, operation: file.operation, baseSha256: file.baseSha256 };
  });
  return { files, commitMessage: parsed.commitMessage };
}

// The interior lines of the single code fence: BBG-<nonce>-ENVELOPE, one META
// line, FILE-NN blocks in files order (delete entries have none), BBG-<nonce>-CLOSE.
function decode(interior, nonce) {
  if (!unicode(interior)) throw fail("unicode", "file response contains invalid Unicode");
  const lines = interior.split("\n");
  const open = /^BBG-(.*)-ENVELOPE\r?$/.exec(lines[0] ?? "");
  if (!open) throw fail("envelope-open", "file response is missing the BBG-<nonce>-ENVELOPE line");
  const { files, commitMessage } = metaFields(lines[1] ?? "", nonce);
  if (open[1] !== nonce) throw fail("nonce", "file response markers carry the wrong nonce");
  const mark = "BBG-" + nonce + "-";
  // The line break after a framing marker may carry a CR from the outer
  // framing; a CR at the end of a content line belongs to the file bytes.
  const marker = (line, suffix) => line === mark + suffix || line === mark + suffix + "\r";
  let pos = 2;
  for (const [index, file] of files.entries()) {
    if (file.operation === "delete") { file.sha256 = null; continue; }
    const nn = String(index + 1).padStart(2, "0");
    if (!marker(lines[pos], "FILE-" + nn + "-BEGIN")) {
      throw fail("file-begin", "file response is missing the " + mark + "FILE-" + nn + "-BEGIN line");
    }
    pos += 1;
    const start = pos;
    while (pos < lines.length && !lines[pos].startsWith(mark)) pos += 1;
    if (!marker(lines[pos], "FILE-" + nn + "-END")) {
      throw fail("file-end", "file block " + nn + " ends with a wrong or missing END marker");
    }
    const content = lines.slice(start, pos).join("\n");
    pos += 1;
    if (!unicode(content) || content.includes("\0")) throw fail("file-content", "file block " + nn + " content is invalid");
    file.content = content;
    file.sha256 = sha256(Buffer.from(content, "utf8"));
  }
  if (!marker(lines[pos], "CLOSE")) {
    throw fail("close", "file response is missing the " + mark + "CLOSE line");
  }
  if (pos + 1 !== lines.length) throw fail("trailing", "file response has lines after the " + mark + "CLOSE line");
  return { files, commitMessage };
}

// The RPC history channel carries the full message text: exactly one outer
// fence, no surrounding text, and no same-character fence inside that is not
// strictly shorter than the outer one.
function fenceInterior(text) {
  const open = /^\s*([\x60]{3,}|~{3,})[^\r\n]*\r?\n/.exec(text);
  const rest = open && text.slice(open[0].length);
  const marker = open?.[1][0] === "\x60" ? "\\x60" : "~";
  const close = open && new RegExp("\n {0,3}(?:" + marker + "){" + open[1].length + ",}[ \t\r]*\n?\\s*$")
    .exec("\n" + rest);
  if (!close) throw fail("fence", "expected exactly one Markdown fence and no surrounding text");
  const interior = rest.slice(0, Math.max(0, close.index - 1));
  const inner = new RegExp("^ {0,3}(?:" + marker + "){" + open[1].length + ",}", "m");
  if (inner.test(interior)) {
    throw fail("fence", "expected exactly one Markdown fence and no surrounding text; " +
      "an inner fence of the same character must be strictly shorter than the outer fence");
  }
  return interior;
}

function rewriteCause(rpcInterior, domInterior) {
  for (const [from, to] of HISTORY_REWRITES) {
    if (rpcInterior === domInterior.split(from).join(to)) {
      return "the `" + from + "` sequence does not survive the saved-history channel; " +
        "rewrite the affected line without it";
    }
  }
  return null;
}

function verifyFileResponse(capture, nonce) {
  const { rpc, dom } = capture ?? {};
  if (rpc?.invalid || dom?.invalid) return { repair: rpc?.invalid || dom.invalid, code: "capture-invalid" };
  if (rpc?.id && dom?.id && rpc.id !== dom.id) {
    return { recapture: "file response channels identify different messages", code: "channels-mismatch" };
  }
  let rpcInterior = null;
  try {
    if (rpc?.id && typeof rpc.text === "string") rpcInterior = fenceInterior(rpc.text);
  } catch (error) {
    return { repair: error.message, code: error.code ?? "fence" };
  }
  const domInterior = dom?.id && typeof dom.text === "string" ? dom.text.replace(/\r?\n$/, "") : null;
  if (rpcInterior === null || domInterior === null) {
    return { recapture: "one or both file response channels are unavailable", code: "channels-unavailable" };
  }
  const sides = [rpcInterior, domInterior].map((interior) => {
    try { return { plan: decode(interior, nonce) }; }
    catch (error) { return { error: error.message, code: error.code ?? "decode" }; }
  });
  if (!sides[0].plan || !sides[1].plan) {
    if (sides[0].plan !== sides[1].plan) {
      const cause = rewriteCause(rpcInterior, domInterior);
      if (cause) return { repair: cause, code: "history-rewrite" };
    }
    const failed = sides[0].error ? sides[0] : sides[1];
    return { repair: failed.error, code: failed.code };
  }
  const metaKey = ({ files, commitMessage }) => JSON.stringify({ files: files.map(
    ({ path, operation, baseSha256 }) => [path, operation, baseSha256]), commitMessage });
  const [left, right] = sides.map(({ plan }) => plan);
  if (metaKey(left) !== metaKey(right) || left.files.some((file, index) => file.sha256 !== right.files[index].sha256)) {
    const cause = rewriteCause(rpcInterior, domInterior);
    return { recapture: "file response channels disagree on content or plan metadata" + (cause ? ": " + cause : ""),
      code: cause ? "history-rewrite" : "channels-disagree" };
  }
  return { plan: left };
}

// Keep tool tags quoted inside file content out of the read-tool loop.
const isFileToolReply = (text) => Boolean(text?.trim()) && text.trim().split(/\r?\n/)
  .every((line) => /^[ \t]*<tool[ \t]+(?:[^>"']|"[^"]*"|'[^']*')+\/>[ \t]*$/.test(line));

module.exports = { FORMAT, sha256, hasCoauthor, verifyFileResponse, isFileToolReply };
