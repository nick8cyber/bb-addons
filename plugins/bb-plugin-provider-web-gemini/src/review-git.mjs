import { execFile } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { executeTool, isSensitivePath, MAX_GREP_LINES, MAX_LIST_ENTRIES, TOOL_TIMEOUT_MS } from "./web-tools.mjs";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const LOCK = /(?:\.lock|[-]lock\.(?:json|yaml)|(?:^|\/)(?:bun\.lockb|npm-shrinkwrap\.json|go\.sum))$/i;
const GENERATED = /(?:^|\/)(?:dist|node_modules)\//i;
const DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--no-renames", "--submodule=short"];
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const runFile = promisify(execFile);

function decodeText(bytes) {
  if (bytes.includes(0)) throw new Error("binary material");
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error("binary or non-UTF-8 material");
  }
}

async function git(cwd, args, { maxBytes = 25_000_000, allow = [], strict = false, binary = false, signal, attributes, isolated } = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_LITERAL_PATHSPECS: "0" };
  if (isolated) {
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    Object.assign(env, {
      GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
      GIT_ATTR_NOSYSTEM: "1",
    });
  }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) delete env[key];
  if (attributes) env.GIT_ATTR_SOURCE = attributes;
  else delete env.GIT_ATTR_SOURCE;
  let result;
  try {
    result = await runFile("git", ["--no-pager", "-c", "core.warnAmbiguousRefs=true", ...args], {
      cwd, env, maxBuffer: maxBytes, timeout: TOOL_TIMEOUT_MS, encoding: "buffer", ...(signal ? { signal } : {}),
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (allow.includes(error.code) && (!error.stderr?.length || args[0] === "rev-parse")) return null;
    const reason = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output exceeds context budget"
      : error.killed ? "command timed out" : "command failed";
    throw new Error(`git ${args[0]}: ${reason}`);
  }
  if (strict && result.stderr.length) throw new Error(`git ${args[0]}: ambiguous commit or Git warning`);
  return binary ? result.stdout : decoder.decode(result.stdout);
}

async function commit(cwd, ref, signal, allow = [], isolated) {
  const output = await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { strict: true, allow, signal, isolated });
  const value = output?.trim();
  if (value == null) return null;
  if (!SHA.test(value)) throw new Error("invalid commit object ID");
  return value;
}

export async function repoRoot(cwd, signal) {
  if (!cwd) return null;
  return (await git(cwd, ["rev-parse", "--show-toplevel"], { allow: [128], signal }))?.trimEnd() ?? null;
}

export async function pinReview(root, refs, environment, signal) {
  if (!refs.length) return null;
  if (!root) throw new Error("review commit requires a Git worktree");
  let sha;
  for (const ref of new Set(refs)) {
    const resolved = await commit(root, ref, signal);
    if (sha && sha !== resolved) throw new Error("conflicting review commits");
    sha = resolved;
  }
  const base = environment.mergeBaseBranch || environment.baseBranch || "refs/remotes/origin/HEAD";
  const candidates = base.startsWith("refs/") || SHA.test(base)
    ? [base]
    : base.startsWith("origin/")
      ? [`refs/remotes/${base}`]
      : [`refs/remotes/origin/${base}`, `refs/heads/${base}`];
  let target = null;
  for (const candidate of candidates) {
    target = await commit(root, candidate, signal, [128]);
    if (target) break;
  }
  if (!target) throw new Error("review base ref cannot be resolved");
  const bases = (await git(root, ["merge-base", "--all", target, sha], { strict: true, signal })).trim().split("\n");
  if (bases.length !== 1 || !SHA.test(bases[0])) throw new Error("review requires one merge-base");
  return Object.freeze({ sha, base: bases[0] });
}

function relPath(value = ".") {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\") || path.isAbsolute(value) || value.split("/").some((s) => s === ".." || s === ".git")) {
    throw new Error("expected a repository-relative path");
  }
  const rel = path.posix.normalize(value).replace(/\/$/, "") || ".";
  if (sensitive(rel)) throw new Error("access denied to sensitive path");
  return rel;
}

function sensitive(rel) {
  return rel.split("/").some((part) => isSensitivePath(part) || /^id_/i.test(part))
    || isSensitivePath(rel);
}

const literal = (rel) => `:(top,literal)${rel}`;
const normalFile = (mode) => mode === "100644" || mode === "100755";
function sessionPath(file, scope) {
  if (scope === ".") return file;
  return file === scope ? "." : file.slice(scope.length + 1);
}

function relativeDiffOptions(scope) {
  return scope === "." ? DIFF_OPTIONS : [...DIFF_OPTIONS, "--relative=" + scope];
}

async function tree(root, sha, signal, rel = ".", recursive = false, isolated) {
  const args = ["ls-tree", "-z", ...(recursive ? ["-r", "-t"] : []), sha];
  if (rel !== ".") args.push("--", literal(rel));
  return (await git(root, args, { signal, isolated })).split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t");
    const [mode, type] = row.slice(0, tab).split(" ");
    return { mode, type, path: row.slice(tab + 1) };
  });
}

async function pinnedEntry(root, sha, rel, signal, isolated) {
  const entry = (await tree(root, sha, signal, rel, false, isolated)).find((item) => item.path === rel);
  if (!entry) throw new Error("path missing from pinned commit");
  return entry;
}

export async function readMaterial(root, pin, value, maxBytes, signal, isolated) {
  const rel = relPath(value);
  if (pin) {
    if (!normalFile((await pinnedEntry(root, pin.sha, rel, signal, isolated)).mode)) throw new Error("expected a regular Git blob");
    return decodeText(await git(root, ["show", `${pin.sha}:${rel}`], { binary: true, maxBytes, signal, isolated }));
  }
  const base = await realpath(root);
  const absolute = path.join(base, rel);
  if (await realpath(absolute) !== absolute) throw new Error("symlink paths are not allowed");
  return readTextFile(absolute, maxBytes, signal);
}

export async function readTextFile(file, maxBytes, signal) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > maxBytes) throw new Error("attachment is not a permitted text file or exceeds upload limit");
    const data = Buffer.alloc(entry.size + 1);
    let offset = 0;
    while (offset < data.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== entry.size || (await handle.stat()).mtimeMs !== entry.mtimeMs) throw new Error("attachment changed while reading");
    return decodeText(data.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

async function diffNames(root, revision, options, scope) {
  const args = ["diff", ...DIFF_OPTIONS, ...revision];
  const lines = (await git(root, [...args, "--raw", "-z", "--", ...scope.map(literal)], options)).split("\0");
  const names = new Map();
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const [from, to] = lines[i].slice(1).split(" ");
    names.set(lines[i + 1], { from, to });
  }
  return names;
}

async function diffPart(root, revision, { maxBytes, signal, attributes, paths: pathspec = [], isolated, scope = ".", skipped }) {
  const options = { maxBytes, signal, attributes, isolated };
  const excluded = [];
  const names = await diffNames(root, revision, options, pathspec);
  let privateCount = 0;
  const paths = [];
  for (const [file, modes] of names) {
    if (sensitive(file)) { privateCount++; continue; }
    if (skipped?.has(file)) continue;
    const reason = LOCK.test(file) ? "lock file" : GENERATED.test(file) ? "generated/dependency tree"
      : [modes.from, modes.to].some((mode) => mode !== "000000" && !normalFile(mode)) ? "symlink or submodule" : null;
    if (reason) excluded.push({ source: sessionPath(file, scope), reason });
    else paths.push(file);
  }
  if (privateCount) excluded.push({ source: "Git diff", reason: `sensitive paths (${privateCount})` });
  const args = ["diff", ...DIFF_OPTIONS, ...revision];
  const displayArgs = ["diff", ...relativeDiffOptions(scope), ...revision];
  let stat = "", patch = "", batch = [], batchBytes = 0;
  const appendPatch = async (paths) => {
    if (!paths.length) return;
    const output = await git(root, [...displayArgs, "-U10", "--", ...paths.map(literal)], { ...options, binary: true });
    try {
      patch += decodeText(output);
    } catch {
      // A diff attribute can force binary bytes into a nominally textual patch.
      // Locate those paths and keep only their already included Git statistics.
      if (paths.length === 1) {
        excluded.push({ source: sessionPath(paths[0], scope), reason: "binary, stat only" });
        return;
      }
      const mid = Math.floor(paths.length / 2);
      await appendPatch(paths.slice(0, mid));
      await appendPatch(paths.slice(mid));
    }
  };
  const flush = async () => {
    if (!batch.length) return;
    const data = await git(root, [...args, "--numstat", "-z", "--", ...batch.map(literal)], options);
    const textPaths = [];
    for (const row of data.split("\0").filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
      if (!match) throw new Error("invalid Git numstat");
      const [, added, removed, file] = match;
      if (added === "-") excluded.push({ source: sessionPath(file, scope), reason: "binary, stat only" });
      else textPaths.push(file);
    }
    stat += await git(root, [...displayArgs, "--stat", "--stat-width=4096", "--", ...batch.map(literal)], options);
    await appendPatch(textPaths);
    if (Buffer.byteLength(stat) + Buffer.byteLength(patch) > maxBytes) throw new Error("Git diff exceeds context budget");
    batch = [];
    batchBytes = 0;
  };
  for (const file of paths) {
    const size = Buffer.byteLength(literal(file)) + 16;
    if (batchBytes + size > 64_000) await flush();
    batch.push(file);
    batchBytes += size;
  }
  await flush();
  return { stat, patch, excluded };
}

function withDiffExclusions(result, { excluded }) {
  return excluded?.length ? { ...result, excluded, partial: true } : result;
}

export async function collectDiff(root, pin, maxBytes, signal) {
  const options = { maxBytes, signal };
  if (pin) return [{ source: "Git review diff", ...await diffPart(root, [pin.base, pin.sha], { ...options, attributes: pin.sha }) }];
  return [
    { source: "Git index diff", ...await diffPart(root, ["--cached"], options) },
    { source: "Git worktree diff", ...await diffPart(root, [], options) },
  ];
}

export async function worktreeStatus(root, maxBytes, signal, isolated, scope = ".", skipped) {
  const rows = await git(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all",
    "--", ...gitScope([], scope).map(literal)], { maxBytes, signal, isolated });
  const entries = rows.split("\0").filter(Boolean);
  const visible = entries.filter((row) => !sensitive(row.slice(3)));
  const text = visible.flatMap((row) => {
    const file = row.slice(3);
    const name = JSON.stringify(sessionPath(file, scope));
    if (!skipped?.has(file)) return [row.slice(0, 3) + name];
    // The staged change is real. The worktree column reflects a file we did not copy.
    return row[0] === " " || row[0] === "?" ? [] : [row[0] + "  " + name];
  }).join("\n");
  return { text, omitted: entries.length - visible.length };
}

export async function executePinned(call, root, pin, diff, maxBytes, signal, isolated = false, scope = ".", shallow = []) {
  const { sha } = pin;
  const args = call.args ?? {};
  const scoped = (value) => path.posix.join(scope, relPath(value));
  const rel = scoped(args.path || ".");
  if (call.name === "read_file") {
    return readLines(await readMaterial(root, pin, rel, maxBytes, signal, isolated), args);
  }
  if (call.name === "list_dir") {
    if (rel !== "." && (await pinnedEntry(root, sha, rel, signal, isolated)).type !== "tree") throw new Error("expected a Git tree");
    const entries = (await tree(root, sha, signal, rel, true, isolated)).filter((item) =>
      (rel === "." || item.path.startsWith(rel + "/")) && !sensitive(item.path) && (item.type === "tree" || normalFile(item.mode)));
    const rows = entries.slice(0, MAX_LIST_ENTRIES).map((item) => sessionPath(item.path, scope) + (item.type === "tree" ? "/" : ""));
    return limited(rows, entries.length, MAX_LIST_ENTRIES);
  }
  if (call.name === "grep") {
    if (!args.pattern) throw new Error("missing grep pattern");
    if (rel !== ".") {
      const entry = await pinnedEntry(root, sha, rel, signal, isolated);
      if (entry.type !== "tree" && !normalFile(entry.mode)) throw new Error("expected a regular Git blob or tree");
    }
    return grepTree(root, sha, args.pattern, rel, { maxBytes, signal, isolated }, scope);
  }
  const argv = gitArgs(args.args);
  const [sub, ...rest] = argv;
  const sep = rest.indexOf("--");
  const opts = sep < 0 ? rest : rest.slice(0, sep);
  const files = sep < 0 ? [] : rest.slice(sep + 1).map(scoped);
  const pinned = (values) => values.every((opt) => opt === sha || opt === "HEAD");
  const revision = async (values) => {
    if (pinned(values)) return sha;
    if (!isolated || values.length !== 1 || !/^(?:[0-9a-f]{7,64}|HEAD(?:[~^][1-9]\d*))$/.test(values[0])) {
      throw new Error("expected a pinned revision or ancestor");
    }
    const ref = await commit(root, values[0], signal, [], true);
    if (ref !== pin.base && await git(root, ["merge-base", "--is-ancestor", ref, sha], {
      allow: [1], signal, isolated: true,
    }) === null) throw new Error("revision is outside the pinned history");
    return ref;
  };
  if (sub === "show" && !files.length && opts.length === 1 && opts[0].includes(":")) {
    const colon = opts[0].indexOf(":");
    const target = await revision([opts[0].slice(0, colon)]);
    return { output: await readMaterial(root, { sha: target }, scoped(opts[0].slice(colon + 1)), maxBytes, signal, isolated),
      revision: target };
  }
  if (sub === "status" && !files.length && opts.every((opt) => ["--short", "-s", "--porcelain"].includes(opt))) {
    diff ??= await diffPart(root, [pin.base, sha], { maxBytes, signal, attributes: sha, paths: gitScope([], scope), isolated, scope });
    return withDiffExclusions({ output: `Pinned commit ${sha}\n${diff.stat}` }, diff);
  }
  if (sub === "ls-files" && !opts.length && !files.length) {
    const entries = (await tree(root, sha, signal, scope, true, isolated)).filter((item) => normalFile(item.mode) && !sensitive(item.path));
    return limited(entries.slice(0, MAX_LIST_ENTRIES).map((item) => sessionPath(item.path, scope)), entries.length, MAX_LIST_ENTRIES);
  }
  if (sub === "blame") {
    const shorthand = isolated && sep === -1 && opts.length > 0 && opts.length <= 2 && !opts.at(-1).startsWith("-");
    const file = shorthand ? scoped(opts.at(-1)) : files.length === 1 ? files[0] : null;
    const target = await revision(shorthand ? opts.slice(0, -1) : opts);
    if (!file || !normalFile((await pinnedEntry(root, target, file, signal, isolated)).mode)) throw new Error("expected a regular file for blame");
    const output = await git(root, ["blame", "--no-textconv", ...(scope === "." ? [] : ["--no-show-name"]), target, "--", file],
      { maxBytes, signal, isolated });
    return withHistory(output, target, shallow);
  }
  if (sub === "log" && (isolated || !files.length)) {
    const countFlag = /^-(?:[1-9]|[1-4][0-9]|50)$/;
    const count = opts.find((opt) => countFlag.test(opt)) ?? "-10";
    const target = await revision(opts.filter((opt) => opt !== "--oneline" && !countFlag.test(opt)));
    const output = await git(root, ["log", count, "--format=%H %s", target, "--", ...gitScope(files, scope).map(literal)],
      { maxBytes, signal, isolated });
    return withHistory(output, target, shallow);
  }
  const range = opts.filter((opt) => opt !== "--stat");
  const validDiffRange = sub === "diff" && (
    pinned(range) ||
    (range.length === 2 && range[0] === pin.base && pinned(range.slice(1))) ||
    (range.length === 1 && [`${pin.base}..${sha}`, `${pin.base}..HEAD`].includes(range[0]))
  );
  if (sub === "diff" && (isolated || validDiffRange)) {
    const refs = range.length === 1 ? range[0].split("..") : range;
    if (isolated && refs.length > 2) throw new Error("expected a range of two revisions");
    const base = isolated && refs.length === 2 ? await revision([refs[0]]) : pin.base;
    const target = isolated ? await revision(refs.slice(-1)) : sha;
    const details = diff && base === pin.base && target === sha && (!files.length || files.includes("."))
      ? diff
      : await diffPart(root, [base, target], { maxBytes, signal, attributes: target, paths: gitScope(files, scope), isolated, scope });
    const output = opts.includes("--stat") ? details.stat : details.patch;
    return withDiffExclusions({ output, revision: target, revisionRange: [base, target] }, details);
  }
  if (sub === "show") {
    const target = await revision(range);
    if (shallow.includes(target)) {
      // Git treats shallow boundaries as root commits and would display a synthetic creation patch.
      const output = await git(root, ["show", "--no-patch", "--format=%H %s", target, "--"], { maxBytes, signal, isolated });
      return withHistory(output, target, [target]);
    }
    let targetFiles = files;
    if (isolated) {
      const data = await git(root, ["diff-tree", "--no-commit-id", "--no-renames", "-r", "--root", "-m", "--raw", "-z", target,
        "--", ...gitScope(files, scope).map(literal)], { maxBytes, signal, isolated });
      const rows = data.split("\0");
      const modes = new Map();
      for (let i = 0; i + 1 < rows.length; i += 2) {
        const [from, to] = rows[i].slice(1).split(" ");
        const file = rows[i + 1];
        modes.set(file, modes.get(file) !== false && [from, to].every((mode) => mode === "000000" || normalFile(mode)));
      }
      targetFiles = [...modes].filter(([, allowed]) => allowed).map(([file]) => file);
    } else if (!targetFiles.length || targetFiles.includes(".")) {
      const treeFiles = (await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "-m", "-z", sha], { maxBytes, signal })) ?? "";
      targetFiles = [...new Set(treeFiles.split("\0").filter(Boolean))];
    }
    const allowed = [];
    for (const file of targetFiles) {
      if (sensitive(file) || LOCK.test(file) || GENERATED.test(file)) continue;
      allowed.push(file);
    }
    const showArgs = ["show", "--format=%H %s", ...relativeDiffOptions(scope)];
    if (opts.includes("--stat")) showArgs.push("--stat");
    else showArgs.push("-U10");
    showArgs.push(target);
    if (!targetFiles.length || !allowed.length) {
      return { output: await git(root, ["show", "--no-patch", "--format=%H %s", target, "--"], { maxBytes, signal, isolated }),
        revision: target };
    }
    showArgs.push("--", ...allowed.map(literal));
    return { output: await git(root, showArgs, { maxBytes, signal, attributes: target, isolated }), revision: target };
  }
  throw new Error("unsupported git arguments for a pinned review; use read_file, list_dir or grep for paths");
}

function gitArgs(value) {
  return [...String(value ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function gitScope(files, scope) {
  return !files.length || files.includes(scope) ? (scope === "." ? [] : [scope]) : files;
}

async function grepTree(root, sha, query, rel, options, scope) {
  const data = await git(root, ["grep", "-E", "--no-recurse-submodules", "--no-textconv", "-z", "-n", "-I", "-e", query,
    ...(sha ? [sha] : ["--untracked"]), "--", ...gitScope([], rel).map(literal)],
  { ...options, allow: [1], attributes: sha }) ?? "";
  const rows = [];
  let total = 0;
  const pattern = /([^\0]+)\0(\d+)\0([^\n]*)(?:\n|$)/gy;
  for (const [, file, line, content] of data.matchAll(pattern)) {
    const name = sha ? file.slice(sha.length + 1) : file;
    if (sensitive(name) || content.includes("\0")) continue;
    total++;
    if (rows.length < MAX_GREP_LINES) rows.push(JSON.stringify(sessionPath(name, scope)) + ":" + line + ":" + content);
  }
  return limited(rows.length ? rows : ["(no matches)"], total, MAX_GREP_LINES);
}

function readLines(content, { from, to }) {
  const lines = content.split("\n");
  const first = /^[1-9]\d*$/.test(from) ? Number(from) : 1;
  const last = /^[1-9]\d*$/.test(to) ? Math.min(Number(to), lines.length) : lines.length;
  const output = first === 1 && last === lines.length ? content : lines.slice(first - 1, last).join("\n");
  return { output, range: { fromLine: first, toLine: last, totalLines: lines.length } };
}

function limited(rows, total, limit) {
  return {
    output: rows.join("\n") + (total > limit ? `\n[showing ${limit} of ${total} results]` : ""),
    range: { included: Math.min(total, limit), total },
  };
}

function withHistory(output, revision, shallow) {
  if (!shallow.length) return { output, revision };
  return { output: appendNote(output, "[History limited by the shallow snapshot]"), revision, shallow };
}

function missingSnapshotPath(error) {
  if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw error;
  return null;
}

function appendNote(output, note) {
  return output + (output && !output.endsWith("\n") ? "\n" : "") + note;
}

function inPaths(file, paths) {
  return !paths.length || paths.some((prefix) => file === prefix || file.startsWith(prefix + "/"));
}

function withSnapshotOmissions(result, skipped, paths = []) {
  const count = paths.length ? [...skipped.keys()].filter((file) => inPaths(file, paths)).length : skipped.size;
  if (!count) return result;
  return { ...result, output: appendNote(result.output, `(${count} paths omitted from the working snapshot)`), partial: true };
}

// Objects are copied via the local Git transport. The snapshot has its own
// config and object store, with no remote, alternates, hooks or checkout filters.
export async function openAgentRepository(context, signal) {
  const { root: source, cwd, pin, settings } = context;
  if (!source) throw new Error("a Git repository is required for isolated reads");
  const sourceRoot = await realpath(source);
  const scope = relPath(path.relative(sourceRoot, cwd));
  const maxBytes = settings.maxTotalBytes;
  const isolated = { signal, isolated: true, maxBytes };
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "web-gemini-read-")));
  const root = path.join(scratch, "repo");
  const close = () => rm(scratch, { recursive: true, force: true });
  try {
    const head = pin?.sha ?? await commit(sourceRoot, "HEAD", signal, [128], true);
    const format = (await git(sourceRoot, ["rev-parse", "--show-object-format"], isolated)).trim();
    await git(scratch, ["init", "--quiet", "--template=", "--object-format=" + format, root], isolated);
    if (head) {
      const refs = [...new Set([head, ...(pin ? [pin.base] : [])])];
      await git(root, ["fetch", "--quiet", "--depth=50", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
        "--", sourceRoot, ...refs], isolated);
      await git(root, ["update-ref", "--no-deref", "HEAD", head], isolated);
    }
    const shallowFile = await readTextFile(path.join(root, ".git", "shallow"), maxBytes, signal).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    const shallow = shallowFile.split("\n").filter(Boolean);
    const snapshot = pin ? null : await copyWorkingSnapshot(sourceRoot, root, scope, head, scratch, isolated);
    return {
      close,
      shallow,
      omitted: snapshot ? [...snapshot.skipped].map(([file, reason]) => ({ source: sessionPath(file, scope), reason })) : [],
      async execute(call) {
        signal.throwIfAborted();
        if (pin) return executePinned(call, root, pin, null, maxBytes, signal, true, scope, shallow);
        return executeWorkingSnapshot(call, root, scope, head, isolated, snapshot, shallow);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function copyWorkingSnapshot(source, root, scope, head, scratch, options) {
  const paths = gitScope([], scope).map(literal);
  const patch = await git(source, ["diff", "--cached", "--binary", ...DIFF_OPTIONS, ...(head ? [head] : []), "--", ...paths],
    { ...options, binary: true });
  if (head) await git(root, ["read-tree", head], options);
  if (patch.length) {
    const file = path.join(scratch, "index.patch");
    await writeFile(file, patch, { mode: 0o600, signal: options.signal });
    await git(root, ["apply", "--cached", "--whitespace=nowarn", "--", file], options);
    await rm(file);
  }
  // Observe deletions in the source before copying so failed copies never appear as deletions.
  const deleted = await git(source, ["ls-files", "-z", "--deleted", "--", ...paths], options);
  const files = await git(source, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths], options);
  // Count true changes in the source. Uncopied sensitive files look deleted inside the snapshot.
  const { omitted: sensitiveCount } = await worktreeStatus(source, options.maxBytes, options.signal, true, scope);
  const skipped = new Map();
  await mkdir(path.join(root, scope), { recursive: true });
  for (const file of new Set(files.split("\0").filter(Boolean))) {
    options.signal.throwIfAborted();
    if (sensitive(file)) continue;
    const rel = relPath(file);
    if (scope !== "." && !rel.startsWith(scope + "/")) continue;
    const reason = await copySnapshotFile(path.join(source, rel), path.join(root, rel), options);
    if (reason) skipped.set(rel, reason);
  }
  return { skipped, sensitiveCount, deleted: deleted.split("\0").filter((file) => file && !sensitive(file)) };
}

async function copySnapshotFile(original, target, { maxBytes, signal }) {
  const entry = await lstat(original).catch(missingSnapshotPath);
  if (!entry) return "path missing from working snapshot";
  if (!entry.isFile()) return "not a regular file in working snapshot";
  if (entry.size > maxBytes) return "file exceeds working snapshot byte limit";
  const resolved = await realpath(original).catch(missingSnapshotPath);
  if (resolved !== original) return "path changed or traverses a symlink";
  const handle = await open(original, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(missingSnapshotPath);
  if (!handle) return "path changed while taking working snapshot";
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev) return "path changed while taking working snapshot";
    if (opened.size > maxBytes) return "file exceeds working snapshot byte limit";
    // Check the open path again before reading, including symlinks in parent directories.
    const current = await realpath(original).catch(missingSnapshotPath);
    if (current !== original) return "path changed or traverses a symlink";
    const mode = opened.mode & 0o755;
    await mkdir(path.dirname(target), { recursive: true });
    if (opened.size) {
      const input = handle.createReadStream({ autoClose: false, end: opened.size - 1 });
      await pipeline(input, createWriteStream(target, { mode }), { signal });
    } else {
      await writeFile(target, "", { mode, signal });
    }
    const final = await handle.stat();
    if (final.size === opened.size && final.mtimeMs === opened.mtimeMs && final.ctimeMs === opened.ctimeMs) return null;
    await rm(target);
    return "file changed while taking working snapshot";
  } finally {
    await handle.close();
  }
}

async function executeWorkingSnapshot(call, root, scope, head, options, { skipped, sensitiveCount, deleted }, shallow) {
  const { maxBytes, signal } = options;
  if (call.name !== "git") {
    const rel = relPath(call.args.path ?? ".");
    const cwd = path.join(root, scope);
    if (call.name === "read_file") return readLines(await readMaterial(cwd, null, rel, maxBytes, signal), call.args);
    const absolute = path.join(cwd, rel);
    const target = path.posix.join(scope, rel);
    const paths = gitScope([], target);
    const resolved = await realpath(absolute).catch(missingSnapshotPath);
    if (!resolved) {
      const result = withSnapshotOmissions({ output: "" }, skipped, paths);
      if (result.partial) return result;
      throw new Error("path missing from working snapshot");
    }
    if (resolved !== absolute) throw new Error("symlink paths are not allowed");
    if (call.name === "grep") {
      const result = await grepTree(root, null, call.args.pattern, target, options, scope);
      return withSnapshotOmissions(result, skipped, paths);
    }
    const result = executeTool({ ...call, args: { path: rel } }, {
      cwd, rejectSensitive: true, mask: String, maxResultBytes: Infinity, includeRanges: true,
    });
    if (!result.ok) throw new Error("directory read failed");
    return withSnapshotOmissions(result, skipped, paths);
  }
  const [sub, ...rest] = gitArgs(call.args.args);
  const sep = rest.indexOf("--");
  const opts = sep < 0 ? rest : rest.slice(0, sep);
  const files = sep < 0 ? [] : rest.slice(sep + 1).map((file) => path.posix.join(scope, relPath(file)));
  if (sub === "status" && !files.length && opts.every((arg) => ["--short", "-s", "--porcelain"].includes(arg))) {
    const { text } = await worktreeStatus(root, maxBytes, signal, true, scope, skipped);
    const lines = [text];
    if (sensitiveCount) lines.push(`(${sensitiveCount} sensitive paths hidden)`);
    return withSnapshotOmissions({ output: lines.filter(Boolean).join("\n"), partial: Boolean(sensitiveCount) }, skipped);
  }
  if (sub === "ls-files" && (!opts.length || (opts.length === 1 && opts[0] === "--deleted"))) {
    const paths = gitScope(files, scope);
    if (opts.length) {
      const entries = [...new Set(deleted.filter((file) => inPaths(file, paths)))].map((file) => sessionPath(file, scope));
      return limited(entries.slice(0, MAX_LIST_ENTRIES), entries.length, MAX_LIST_ENTRIES);
    }
    const rows = await git(root, ["ls-files", "-z", "--", ...paths.map(literal)], options);
    const entries = [...new Set(rows.split("\0").filter((file) => file && !sensitive(file) && !skipped.has(file)))]
      .map((file) => sessionPath(file, scope));
    return withSnapshotOmissions(limited(entries.slice(0, MAX_LIST_ENTRIES), entries.length, MAX_LIST_ENTRIES), skipped, paths);
  }
  if (sub === "diff" && opts.every((arg) => ["--stat", "--cached", "--staged", "HEAD"].includes(arg))) {
    const revision = opts.filter((arg) => arg !== "--stat");
    const cached = revision.includes("--cached") || revision.includes("--staged");
    const paths = gitScope(files, scope);
    const details = await diffPart(root, revision, {
      ...options, paths, scope, skipped: cached ? undefined : skipped,
    });
    const result = withDiffExclusions({ output: opts.includes("--stat") ? details.stat : details.patch }, details);
    return cached ? result : withSnapshotOmissions(result, skipped, paths);
  }
  if (head && ["show", "log", "blame"].includes(sub)) {
    return executePinned(call, root, { sha: head }, null, maxBytes, signal, true, scope, shallow);
  }
  throw new Error("unsupported Git arguments");
}
