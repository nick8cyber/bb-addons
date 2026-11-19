import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import envelope from "./file-envelope.cjs";
import { isSensitivePath } from "./web-tools.mjs";

const { sha256, hasCoauthor } = envelope;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const regularMode = (mode) => mode === "100644" || mode === "100755";
const within = (root, path) => path === root || path.startsWith(root + "/");
// Эксплуатационный сбой среды записи — занятый lock, сдвинувшаяся после
// preflight копия или индекс, упавший git, незаданный автор. Метка writeEnv
// отличает его от ошибки файлового плана модели (PLUG-351): веб-модель не
// получает бесполезный запрос исправления за чужой сбой.
const envError = (message) => Object.assign(new Error(message), { writeEnv: true });

function lstat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function syncDir(dir) {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function writeNew(path, bytes, mode) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function saveIntent(file, value) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    writeNew(temp, JSON.stringify(value), 0o600);
    renameSync(temp, file);
    syncDir(dirname(file));
  } finally {
    if (lstat(temp)) unlinkSync(temp);
  }
}

export function outputPath(path) {
  if (typeof path !== "string" || !path || /^[a-z]:/i.test(path) || /[\\\x00-\x1f\x7f]/.test(path) ||
      /[\uD800-\uDFFF]/u.test(path) || path.split("/").some((name) =>
        !name || name === "." || name === ".." || /^[:!^]/.test(name) ||
        /^(?:\.git|node_modules|id_.*)$/i.test(name) || isSensitivePath(name)) ||
      isSensitivePath(path)) throw new Error("invalid or protected output path");
  return path;
}

export function resultPaths(text) {
  let paths = null;
  let inside = false;
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const boundary = /^ {0,3}([\x60]{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (boundary && boundary[1][0] === fence[0] && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null;
      continue;
    }
    if (boundary && !inside) { fence = boundary[1]; continue; }
    if (/^## (?:Файлы результата|Result files)[ \t]*$/i.test(line)) {
      if (paths) throw new Error("repeated result files section");
      paths = new Set();
      inside = true;
    } else if (/^#{1,2}[ \t]+/.test(line)) {
      inside = false;
    } else if (inside && line.trim()) {
      const match = /^- ([^\r\n]+)$/.exec(line);
      if (!match || match[1] !== match[1].trim()) throw new Error("expected a list of exact output paths");
      const path = outputPath(match[1].replace(/^`(.*)`$/, "$1"));
      if (paths.has(path)) throw new Error("duplicate path in result files section");
      paths.add(path);
    }
  }
  if (paths?.size === 0) throw new Error("empty result files section");
  return paths ? [...paths] : null;
}

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR$|WORK_TREE$|COMMON_DIR$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$|NAMESPACE$|ATTR_SOURCE$|[A-Z_]*PATHSPECS$|CONFIG$|CONFIG_COUNT$|CONFIG_PARAMETERS$|CONFIG_(?:KEY|VALUE)_|AUTHOR_|COMMITTER_|REFLOG_ACTION$)/.test(key)) delete env[key];
  }
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
}

function run(file, args, { cwd, fd, env, input, signal }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd, env, detached: Boolean(signal), stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore", ...(fd === null ? [] : [fd])],
    });
    let size = 0;
    const output = [];
    let killTimer;
    const killGroup = (kind) => { try { process.kill(-child.pid, kind); } catch {} };
    const abort = () => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 32_000_000) output.push(chunk);
    });
    child.stdin?.on("error", () => {}); // A rejecting Git hook can close stdin first.
    child.stdin?.end(input);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (size > 32_000_000) reject(envError("Git output exceeds transaction limit"));
      else resolve({ code, output: Buffer.concat(output) });
    });
  });
}

function entries(bytes, index = false) {
  return new Map(decoder.decode(bytes).split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t");
    const [mode, typeOrOid, oidOrStage] = row.slice(0, tab).split(" ");
    if (index && oidOrStage !== "0") throw envError("unmerged Git index");
    return [row.slice(tab + 1), { mode, oid: index ? typeOrOid : oidOrStage }];
  }));
}

const sameEntry = (a, b) => a?.mode === b?.mode && a?.oid === b?.oid;
const changed = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((path) => !sameEntry(a.get(path), b.get(path)));
const gitMode = (stat) => (stat.mode & 0o100) ? "100755" : "100644";
const pathspec = (paths) => paths.join("\0") + "\0";

function text(bytes) {
  if (bytes.includes(0)) throw new Error("binary output file or base");
  try { return decoder.decode(bytes); }
  catch { throw new Error("non-UTF-8 output file or base"); }
}

export class WorktreeWriter {
  constructor(root, stateDir, environment) {
    if (!environment?.managed || !environment.isWorktree || !environment.isGitRepo || !environment.branchName ||
        !root || realpathSync(root) !== realpathSync(environment.path)) {
      throw envError("accept-edits requires the dedicated managed BB Git worktree");
    }
    this.root = root;
    this.stateDir = realpathSync(stateDir);
    if (within(root, this.stateDir)) throw envError("provider state must be outside the worktree");
    this.branch = environment.branchName;
    this.ref = "refs/heads/" + this.branch;
    this.env = gitEnv();
    this.fd = null;
  }

  async git(args, { input, signal, allow = [], env = {} } = {}) {
    // check-ignore rejects literal pathspecs. outputPath rejects magic prefixes before the check.
    const literal = args[0] === "check-ignore" ? [] : ["--literal-pathspecs"];
    const { code, output } = await run("git", [...literal, "--no-pager", ...args], {
      cwd: this.root, fd: this.fd, env: { ...this.env, ...env }, input, signal,
    });
    if (code !== 0 && !allow.includes(code)) throw envError("git " + (args[0] === "-c" ? args[2] : args[0]) + " failed");
    return code === 0 ? output : null;
  }

  async gitText(args, options) {
    return (await this.git(args, options))?.toString("utf8").trimEnd();
  }

  async lock(signal) {
    const gitDir = realpathSync(await this.gitText(["rev-parse", "--absolute-git-dir"]));
    const common = realpathSync(resolve(this.root, await this.gitText(["rev-parse", "--git-common-dir"])));
    const top = realpathSync(await this.gitText(["rev-parse", "--show-toplevel"]));
    if (gitDir === common || top !== this.root) throw envError("accept-edits requires a linked Git worktree root");
    const locks = join(this.stateDir, "locks");
    mkdirSync(locks, { recursive: true, mode: 0o700 });
    syncDir(this.stateDir);
    this.fingerprint = { cwd: this.root, gitDir };
    const key = sha256(JSON.stringify(this.fingerprint));
    this.intentFile = join(locks, key + ".json");
    // flock locks the open file description shared with the parent. Every Git
    // child also inherits it, including the commit process while it runs hooks.
    this.fd = openSync(join(locks, key + ".lock"),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const result = await run("flock", ["-n", "3"], { fd: this.fd, signal });
      if (result.code !== 0) throw envError("worktree is locked by another writer");
      signal?.throwIfAborted();
    } catch (error) {
      this.close();
      if (error.code === "ENOENT") throw envError("exclusive worktree locking is unavailable");
      throw error;
    }
  }

  close() {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  async head() {
    if (await this.gitText(["symbolic-ref", "-q", "HEAD"], { allow: [1] }) !== this.ref) {
      throw envError("worktree HEAD does not name the trusted branch");
    }
    const sha = await this.gitText(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!objectId.test(sha)) throw envError("invalid worktree HEAD");
    return { sha, branch: this.branch };
  }

  async status() {
    const bytes = await this.git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z",
      "--untracked-files=all", "--ignore-submodules=none", "--no-renames"]);
    return decoder.decode(bytes).split("\0").filter(Boolean).filter((row) => {
      if (!row.startsWith("?? ")) return true;
      const parts = row.slice(3).split("/");
      const i = parts.indexOf("node_modules");
      if (i < 0) return true;
      const stat = lstat(join(this.root, ...parts.slice(0, i + 1)));
      return !stat?.isDirectory() && !stat?.isSymbolicLink();
    });
  }

  async prepare() {
    const head = await this.head();
    if ((await this.status()).length) throw envError("write requires a clean index and worktree");
    const name = await this.gitText(["config", "--get", "user.name"], { allow: [1] });
    const email = await this.gitText(["config", "--get", "user.email"], { allow: [1] });
    if (!name?.trim() || !email?.trim()) throw envError("Git author name and email must be configured");
    await this.git(["var", "GIT_AUTHOR_IDENT"]);
    return head;
  }

  tree(sha) { return this.git(["ls-tree", "-r", "-z", sha]).then((bytes) => entries(bytes)); }
  index() { return this.git(["ls-files", "--stage", "-z"]).then((bytes) => entries(bytes, true)); }
  blob(oid) { return this.git(["cat-file", "blob", oid]); }

  working(path) {
    outputPath(path);
    const parts = path.split("/");
    const missing = [];
    let dir = this.root;
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      const stat = lstat(dir);
      if (!stat) missing.push(relative(this.root, dir));
      else if (!stat.isDirectory() || lstat(join(dir, ".git"))) throw new Error("output parent is not a regular repository directory");
    }
    const absolute = join(dir, parts.at(-1));
    const stat = lstat(absolute);
    if (!stat) return { absolute, missing, stat, hash: null };
    if (!stat.isFile()) throw new Error("output path is not a regular file");
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const bytes = readFileSync(fd);
      return { absolute, missing, stat, hash: sha256(bytes), bytes };
    } finally { closeSync(fd); }
  }

  async preflightPath(path, base) {
    const working = this.working(path);
    if (await this.git(["check-ignore", "--no-index", "-q", "--", "./" + path], { allow: [1] }) !== null) {
      throw new Error("output path is ignored by Git");
    }
    const components = path.split("/");
    for (let i = 1; i < components.length; i += 1) {
      if (base.has(components.slice(0, i).join("/"))) throw new Error("output path crosses a tracked file or submodule");
    }
    return working;
  }

  async baseInfo(head, path) {
    const base = await this.tree(head.sha);
    const working = await this.preflightPath(path, base);
    const entry = base.get(path);
    if (!entry) return null;
    if (!regularMode(entry.mode) || !working.stat || gitMode(working.stat) !== entry.mode) {
      throw new Error("output base does not match the working file mode");
    }
    const bytes = await this.blob(entry.oid);
    const hash = sha256(bytes);
    if (working.hash !== hash) throw new Error("output base does not match the working file bytes");
    const value = text(bytes);
    return { baseSha256: hash, ...(value.normalize("NFC") === value ? {} : { replaceDenied: "base text is not NFC" }) };
  }

  async plan(head, envelope, allowedPaths, issuedBases) {
    if ((await this.head()).sha !== head.sha || (await this.status()).length) throw envError("worktree changed since write preflight");
    const base = await this.tree(head.sha);
    const index = await this.index();
    if (changed(base, index).length) throw envError("index changed since write preflight");
    const flagged = new Set(decoder.decode(await this.git(["ls-files", "-v", "-z"])).split("\0")
      .filter((row) => row && !row.startsWith("H ")).map((row) => row.slice(2)));
    const files = [];
    const dirs = new Set();
    for (const file of envelope.files) {
      const { path, operation, baseSha256, sha256: hash } = file;
      if (allowedPaths && !allowedPaths.includes(path)) throw new Error("output path is outside the result files section");
      const work = await this.preflightPath(path, base);
      const entry = base.get(path);
      if (flagged.has(path)) throw new Error("output path has nonstandard Git index flags");
      let permissions = 0o644;
      if (operation === "create") {
        if (entry || work.stat) throw new Error("create requires an absent output path");
        for (const dir of work.missing) dirs.add(dir);
      } else {
        if (!entry || !regularMode(entry.mode) || !work.stat || gitMode(work.stat) !== entry.mode ||
            work.hash !== baseSha256 || sha256(await this.blob(entry.oid)) !== baseSha256 ||
            issuedBases.get(path)?.baseSha256 !== baseSha256) throw new Error("output base SHA-256, mode or issued material does not match");
        const value = text(work.bytes);
        if (operation === "replace" && value.normalize("NFC") !== value) throw new Error("replace denied: base text is not NFC");
        if (hash === baseSha256) throw new Error("replace must change the original bytes");
        permissions = work.stat.mode & 0o7777;
      }
      files.push({ path, operation, baseSha256, hash, mode: operation === "delete" ? null : entry?.mode ?? "100644", permissions,
        temp: join(dirname(path), ".web-gemini-" + randomUUID() + ".tmp") });
    }
    if (files.some(({ path }) => dirs.has(path))) throw new Error("output paths include a file and its descendant");
    return { files, dirs: [...dirs].sort() };
  }

  async verifyTree(intent, base, candidate) {
    const expected = new Map(intent.files.map((file) => [file.path, file]));
    const diff = changed(base, candidate);
    if (diff.length !== expected.size || diff.some((path) => !expected.has(path))) {
      throw new Error("Git changes do not match the file plan");
    }
    for (const { path, hash, mode } of intent.files) {
      const entry = candidate.get(path);
      if (mode !== (entry?.mode ?? null) || (entry && sha256(await this.blob(entry.oid)) !== hash)) {
        throw new Error("Git blob bytes or mode differ from the file response");
      }
    }
  }

  verifyWorking(intent) {
    for (const file of intent.files) {
      const work = this.working(file.path);
      if (work.hash !== file.hash || (work.stat && (work.stat.mode & 0o7777) !== file.permissions)) {
        throw new Error("working file bytes or permissions differ from the file response");
      }
    }
  }

  async verifyCommit(intent, sha) {
    if ((await this.head()).sha !== sha ||
        await this.gitText(["show", "-s", "--format=%P", sha]) !== intent.head.sha) {
      throw new Error("commit does not have the original branch and single parent");
    }
    const committed = await this.tree(sha);
    await this.verifyTree(intent, await this.tree(intent.head.sha), committed);
    if (changed(committed, await this.index()).length || (await this.status()).length) {
      throw new Error("commit left changes in the index or worktree");
    }
    if (hasCoauthor(await this.gitText(["show", "-s", "--format=%B", sha]))) {
      throw new Error("commit message contains a prohibited co-author trailer");
    }
    this.verifyWorking(intent);
  }

  async ownsHead(intent, head) {
    const entry = await this.gitText(["reflog", "show", "-1", "--format=%H%x00%gs", this.ref]);
    return Boolean(entry?.startsWith(head + "\0web-gemini-" + intent.id + ": "));
  }

  async clearIntent() {
    unlinkSync(this.intentFile);
    syncDir(dirname(this.intentFile));
  }

  async recover(checkpoint) {
    if (!lstat(this.intentFile)) return;
    let intent;
    try {
      intent = JSON.parse(readFileSync(this.intentFile, "utf8"));
      this.validateIntent(intent);
      const { sha } = await this.head();
      if (!intent.rollback && sha !== intent.head.sha && await this.ownsHead(intent, sha)) {
        const verified = await this.verifyCommit(intent, sha).then(() => true, () => false);
        if (verified) {
          checkpoint(intent.owner, { sha, head: intent.head, files: intent.files });
          return await this.clearIntent();
        }
      }
      await this.rollback(intent);
      checkpoint(intent.owner, null);
      await this.clearIntent();
    } catch (error) {
      if (intent && typeof intent === "object") {
        try { saveIntent(this.intentFile, { ...intent, recoveryRequired: true }); } catch {}
      }
      throw new Error("recovery_required: " + (error.code ? "unable to restore the worktree" : error.message));
    }
  }

  validateIntent(intent) {
    const invalid = () => { throw new Error("invalid worktree recovery journal"); };
    if (intent?.version !== 1 || intent.head?.branch !== this.branch || !objectId.test(intent.head.sha) ||
        !/^[a-f0-9-]{36}$/.test(intent.id) || !Array.isArray(intent.files) ||
        !intent.files.length || !Array.isArray(intent.dirs)) invalid();
    const paths = new Set();
    for (const file of intent.files) {
      const { path, temp, operation, baseSha256, hash, mode, permissions, staged } = file;
      const sha256Pattern = /^[a-f0-9]{64}$/;
      if (paths.has(outputPath(path)) || dirname(outputPath(temp)) !== dirname(path) ||
          !/^\.web-gemini-[a-f0-9-]{36}\.tmp$/.test(basename(temp)) ||
          !Number.isInteger(permissions) || permissions < 0 || permissions > 0o7777 ||
          !["create", "replace", "delete"].includes(operation) ||
          (operation === "create" ? baseSha256 !== null : !sha256Pattern.test(baseSha256)) ||
          (operation === "delete" ? hash !== null || mode !== null : !sha256Pattern.test(hash) || !regularMode(mode)) ||
          (staged && (!regularMode(staged.mode) || !objectId.test(staged.oid)))) invalid();
      paths.add(path);
    }
    if (intent.dirs.some((dir) => !intent.files.some(({ path, operation }) =>
      operation === "create" && path.startsWith(outputPath(dir) + "/")))) invalid();
  }

  async rollback(intent) {
    const { sha } = await this.head();
    const base = await this.tree(intent.head.sha);
    const index = await this.index();
    const paths = new Set(intent.files.map((file) => file.path));
    let owned = null;
    if (sha !== intent.head.sha) {
      if (!await this.ownsHead(intent, sha) ||
          await this.gitText(["show", "-s", "--format=%P", sha]) !== intent.head.sha) {
        throw new Error("branch moved independently of the transaction");
      }
      owned = await this.tree(sha);
    }
    if (changed(base, index).some((path) => !paths.has(path))) throw new Error("unrelated changes in the Git index");
    // Inspect every path before restoring any, so a later conflict does not
    // partially erase changes that an operator needs to resolve.
    for (const file of intent.files) {
      const { path, hash, baseSha256, temp } = file;
      const work = this.working(path);
      const before = base.get(path);
      if (before ? !regularMode(before.mode) || sha256(await this.blob(before.oid)) !== baseSha256 : baseSha256 !== null) {
        throw new Error("base file differs from the recovery journal");
      }
      const entry = index.get(path);
      const ownedEntry = owned?.get(path);
      const ownedHash = ownedEntry && regularMode(ownedEntry.mode) ? sha256(await this.blob(ownedEntry.oid)) : null;
      const known = new Set([hash, baseSha256]);
      if (owned) known.add(ownedHash);
      if (!known.has(work.hash) || (!entry && !known.has(null)) ||
          (entry && (!regularMode(entry.mode) || (!sameEntry(entry, file.staged) && !known.has(sha256(await this.blob(entry.oid))))))) {
        throw new Error("working file or index differs from the recovery journal");
      }
      const sibling = this.working(temp);
      if (sibling.stat && sibling.stat.nlink !== 1) throw new Error("temporary file differs from the recovery journal");
    }
    for (const file of intent.files) {
      const temp = this.working(file.temp);
      if (temp.stat) unlinkSync(temp.absolute);
      const work = this.working(file.path);
      const before = base.get(file.path);
      if (!before && work.stat) unlinkSync(work.absolute);
      if (before && (work.hash !== file.baseSha256 || (work.stat.mode & 0o7777) !== file.permissions)) {
        writeNew(temp.absolute, await this.blob(before.oid), file.permissions);
        renameSync(temp.absolute, work.absolute);
      }
      if (lstat(dirname(work.absolute))) syncDir(dirname(work.absolute));
    }
    for (const dir of [...intent.dirs].reverse()) {
      if (!lstat(join(this.root, dir))) continue;
      try { rmdirSync(join(this.root, dir)); }
      catch (error) { if (error.code !== "ENOTEMPTY") throw error; }
      syncDir(dirname(join(this.root, dir)));
    }
    // This is a path-limited index restore; it changes neither HEAD nor
    // the working copy. Move the ref separately with an expected old value.
    await this.git(["reset", "--quiet", intent.head.sha, "--pathspec-from-file=-", "--pathspec-file-nul"], {
      input: pathspec([...paths]),
    });
    if (owned) await this.git(["update-ref", this.ref, intent.head.sha, sha]);
    if ((await this.head()).sha !== intent.head.sha || changed(base, await this.index()).length || (await this.status()).length) {
      throw new Error("worktree is not clean after addressed restoration");
    }
  }

  async apply({ head, envelope, allowedPaths, issuedBases, owner, signal, progress, checkpoint }) {
    const plan = await this.plan(head, envelope, allowedPaths, issuedBases);
    const intent = { ...plan, head, owner, version: 1, id: randomUUID() };
    signal.throwIfAborted();
    saveIntent(this.intentFile, intent);
    try {
      progress("write");
      for (const dir of plan.dirs) {
        mkdirSync(join(this.root, dir), { mode: 0o755 });
        syncDir(dirname(join(this.root, dir)));
      }
      for (const [i, file] of intent.files.entries()) {
        signal.throwIfAborted();
        const work = this.working(file.path);
        if (work.hash !== file.baseSha256 || (work.stat && (work.stat.mode & 0o7777) !== file.permissions)) {
          throw envError("working file changed before it could be written");
        }
        if (file.operation === "delete") unlinkSync(work.absolute);
        else {
          const temp = this.working(file.temp).absolute;
          writeNew(temp, Buffer.from(envelope.files[i].content, "utf8"), file.permissions);
          renameSync(temp, work.absolute);
        }
        syncDir(dirname(work.absolute));
      }
      try {
        await this.git(["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          input: pathspec(intent.files.map((file) => file.path)), signal,
        });
      } finally {
        // A clean filter may produce different staged bytes. Record the actual
        // blobs for safe rollback, and still require the verified bytes to commit.
        const staged = await this.index();
        for (const file of intent.files) file.staged = staged.get(file.path);
        saveIntent(this.intentFile, intent);
      }
      progress("commit");
      if ((await this.head()).sha !== head.sha) throw envError("branch changed before commit");
      await this.verifyTree(intent, await this.tree(head.sha), await this.index());
      this.verifyWorking(intent);
      const plannedStatus = new Set(intent.files.map((file) => file.path));
      if ((await this.status()).some((row) => row[1] !== " " || !plannedStatus.has(row.slice(3)))) {
        throw envError("worktree changed before commit");
      }
      await this.git(["-c", "core.logAllRefUpdates=true", "commit", "--cleanup=verbatim", "-F", "-"], {
        input: envelope.commitMessage, signal, env: { GIT_REFLOG_ACTION: "web-gemini-" + intent.id },
      });
      const { sha } = await this.head();
      if (!await this.ownsHead(intent, sha)) throw envError("could not identify the transaction commit");
      await this.verifyCommit(intent, sha);
      signal.throwIfAborted();
      checkpoint(owner, { sha, head, files: intent.files });
      await this.clearIntent();
      return sha;
    } catch (error) {
      try {
        saveIntent(this.intentFile, { ...intent, rollback: true });
        await this.recover(checkpoint);
      } catch (recovery) {
        throw new Error(recovery.message.startsWith("recovery_required:") ? recovery.message : "recovery_required: could not save rollback state");
      }
      throw error;
    }
  }
}
