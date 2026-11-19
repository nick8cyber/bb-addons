const { createHash } = require("node:crypto");

const FORMAT = "web-gemini-files-v1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unicode = (value) => typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value);
const hasCoauthor = (value) => /^[ \t]*co-authored-by[ \t]*:/im.test(value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

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

function decode(json, nonce) {
  if (!unicode(json)) throw new Error("file response contains invalid Unicode");
  let parsed;
  try { parsed = JSON.parse(json); }
  catch (error) {
    const position = /\bposition (\d+)/.exec(error.message)?.[1];
    throw new Error("file response contains invalid JSON" + (position ? " near character " + position : ""));
  }
  if (!hasKeys(parsed, ["format", "nonce", "files", "commitMessage"]) || parsed.format !== FORMAT ||
      !Array.isArray(parsed.files) || !parsed.files.length || !unicode(parsed.commitMessage) ||
      !parsed.commitMessage.trim() || parsed.commitMessage.includes("\0") ||
      hasCoauthor(parsed.commitMessage) || !uniqueKeys(json)) {
    throw new Error("invalid file envelope fields or commit message");
  }
  if (parsed.nonce !== nonce) throw new Error("file response has the wrong nonce");
  const paths = new Set();
  const files = parsed.files.map((file) => {
    const operation = file?.operation;
    const keys = ["path", "operation", "baseSha256"];
    if (operation !== "delete") keys.push("content");
    if (!hasKeys(file, keys) || !unicode(file.path) || !file.path || paths.has(file.path) ||
        !["create", "replace", "delete"].includes(operation) ||
        (operation === "create" ? file.baseSha256 !== null :
          typeof file.baseSha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.baseSha256)) ||
        (operation !== "delete" && (!unicode(file.content) || file.content.includes("\0")))) {
      throw new Error("invalid file entry or duplicate path");
    }
    paths.add(file.path);
    return { ...file, sha256: operation === "delete" ? null : sha256(Buffer.from(file.content, "utf8")) };
  });
  return { files, commitMessage: parsed.commitMessage };
}

function verifyFileResponse(capture, nonce) {
  const { rpc, dom } = capture ?? {};
  if (rpc?.invalid || dom?.invalid) return { repair: rpc?.invalid || dom.invalid };
  if (rpc?.id && dom?.id && rpc.id !== dom.id) return { recapture: "file response channels identify different messages" };
  try {
    let left;
    if (rpc?.id && typeof rpc.text === "string") {
      const match = /^\s*([\x60]{3,}|~{3,})json[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*\s*$/.exec(rpc.text);
      if (!match || /^ {0,3}(?:[\x60]{3,}|~{3,})/m.test(match[2])) {
        throw new Error("expected exactly one json fence and no surrounding text");
      }
      left = decode(match[2], nonce);
    }
    const right = dom?.id && typeof dom.text === "string" ? decode(dom.text, nonce) : null;
    if (!left || !right) return { recapture: "one or both file response channels are unavailable" };
    const rightFiles = new Map(right.files.map((file) => [file.path, file]));
    if (left.commitMessage !== right.commitMessage || left.files.length !== right.files.length ||
        left.files.some((file) => {
          const other = rightFiles.get(file.path);
          return !other || file.operation !== other.operation || file.baseSha256 !== other.baseSha256 || file.sha256 !== other.sha256;
        })) {
      return { recapture: "file response channels disagree on content or plan metadata" };
    }
    return { plan: left };
  } catch (error) {
    return { repair: error.message };
  }
}

// Keep tool tags quoted inside file content out of the read-tool loop.
const isFileToolReply = (text) => Boolean(text?.trim()) && text.trim().split(/\r?\n/)
  .every((line) => /^[ \t]*<tool[ \t]+(?:[^>"']|"[^"]*"|'[^']*')+\/>[ \t]*$/.test(line));

module.exports = { FORMAT, sha256, hasCoauthor, verifyFileResponse, isFileToolReply };
