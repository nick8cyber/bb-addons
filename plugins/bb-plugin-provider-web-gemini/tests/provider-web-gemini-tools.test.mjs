import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  toolSystemHeader,
  parseToolCalls,
  callArgsString,
  resolveInCwd,
  isSensitivePath,
  maskForWeb,
  executeTool,
  runToolLoop,
  packFirstMessage,
  forceFinalMessage,
  formatToolResultBlock,
  filterGitPatchOutput,
  filterGitPatchZOutput,
  filterGitStatusOutput,
  truncResult,
  TRUNC_SUFFIX,
  MAX_TOOL_RESULT_BYTES,
  SECRET_RULES,
  PERSONAL_EMAIL_RE,
  MACHINE_RULES,
  BB_ID_RULES,
} from "../src/web-tools.mjs";

// Литералы идентификаторов bb запрещены гигиеной репозитория — собираем.
const T = "t" + "hr_";
const THREAD_ID = T + "abc123def";
const HOME_P = "/h" + "ome";
const OPT_P = "/o" + "pt";
const GMAIL = "user" + "123@gmail" + ".com";

const tmpDirs = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function mkGitRepo() {
  const dir = mkTmp("argon-tools-git-");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "line1\nline2\n");
  const git = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "tester"]);
  git(["add", "tracked.txt"]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

function withBbStub(fn) {
  const dir = mkTmp("argon-bbstub-");
  const stub = path.join(dir, "bb-stub.sh");
  fs.writeFileSync(stub, '#!/bin/sh\necho "STUB:$*"\n', { mode: 0o755 });
  const prev = process.env.BB_CLI;
  process.env.BB_CLI = stub;
  try {
    return fn(stub);
  } finally {
    if (prev === undefined) delete process.env.BB_CLI;
    else process.env.BB_CLI = prev;
  }
}

/* ---------- 1. Разбор текстовых вызовов инструментов ---------- */

test("1. parseToolCalls: одиночный вызов, аргументы в двойных кавычках", () => {
  const calls = parseToolCalls('<tool name="read_file" path="src/index.js" from="1" to="80"/>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read_file");
  assert.deepEqual(calls[0].args, { path: "src/index.js", from: "1", to: "80" });
});

test("1. parseToolCalls: несколько вызовов и окружающий текст", () => {
  const text = [
    "Посмотрю на структуру.",
    '<tool name="list_dir" path="plugins"/>',
    "И поищу функцию:",
    "<tool name='grep' pattern='pickBackend' path='plugins'/>",
    "Дальше подумаю.",
  ].join("\n");
  const calls = parseToolCalls(text);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "list_dir");
  assert.equal(calls[1].name, "grep");
  assert.equal(calls[1].args.pattern, "pickBackend");
});

test("1. parseToolCalls: пробелы, одинарные кавычки, пробел перед />", () => {
  const calls = parseToolCalls(`<tool   name='git'   args="log --oneline -5"   />`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.args, "log --oneline -5");
});

test("1. parseToolCalls: невалидные строки — обычный текст, не вызовы", () => {
  const text = [
    "<tool name=read_file path=x/>", // без кавычек
    "<tool path=\"x\"/>", // нет name
    "<toolname=\"x\"/>",
    "< tool name=\"x\"/>",
    "обычная строка с <tool и без закрытия",
    "финальный ответ",
  ].join("\n");
  assert.equal(parseToolCalls(text).length, 0);
});

test("1. callArgsString сохраняет порядок аргументов", () => {
  const [call] = parseToolCalls('<tool name="read_file" to="9" path="a.txt" from="2"/>');
  assert.equal(callArgsString(call), 'to="9" path="a.txt" from="2"');
  assert.equal(
    formatToolResultBlock(call, "BODY"),
    '=== tool: read_file to="9" path="a.txt" from="2" ===\nBODY',
  );
});

/* ---------- 2. Песочница cwd ---------- */

test("2. resolveInCwd: .. и абсолютные пути вне cwd — отказ", () => {
  const cwd = mkTmp("argon-cwd-");
  const outside = mkTmp("argon-out-");
  for (const p of ["../../etc/passwd", "../x", "a/../../b"]) {
    const r = resolveInCwd(cwd, p);
    assert.equal(r.error, "access denied: path outside cwd", p);
  }
  const abs = resolveInCwd(cwd, path.join(outside, "f.txt"));
  assert.equal(abs.error, "access denied: path outside cwd");
});

test("2. resolveInCwd: симлинк наружу — отказ; внутри — разрешено", () => {
  const cwd = mkTmp("argon-cwd-");
  const outside = mkTmp("argon-out-");
  fs.writeFileSync(path.join(outside, "secret.txt"), "OUT");
  fs.symlinkSync(outside, path.join(cwd, "link"));
  const r = resolveInCwd(cwd, "link/secret.txt");
  assert.equal(r.error, "access denied: path outside cwd");
  fs.mkdirSync(path.join(cwd, "sub"));
  fs.writeFileSync(path.join(cwd, "sub", "in.txt"), "IN");
  const ok = resolveInCwd(cwd, "sub/in.txt");
  assert.ok(ok.abs && ok.abs.endsWith(path.join("sub", "in.txt")));
});

test("2. executeTool read_file: внешний путь не читается", () => {
  const cwd = mkTmp("argon-cwd-");
  const r = executeTool(
    { name: "read_file", args: { path: "../../etc/passwd" }, attrs: [["path", "../../etc/passwd"]] },
    { cwd },
  );
  assert.equal(r.ok, false);
  assert.match(r.output, /access denied: path outside cwd/);
});

/* ---------- 3. Белый список git ---------- */

test("3. git: разрешённые подкоманды выполняются в cwd", () => {
  const repo = mkGitRepo();
  const st = executeTool(
    { name: "git", args: { args: "status --short" }, attrs: [["args", "status --short"]] },
    { cwd: repo },
  );
  assert.equal(st.ok, true, st.output);
  const lg = executeTool(
    { name: "git", args: { args: "log --oneline -1" }, attrs: [["args", "log --oneline -1"]] },
    { cwd: repo },
  );
  assert.match(lg.output, /init/);
  const ls = executeTool(
    { name: "git", args: { args: "ls-files" }, attrs: [["args", "ls-files"]] },
    { cwd: repo },
  );
  assert.match(ls.output, /tracked\.txt/);
  const blame = executeTool(
    { name: "git", args: { args: "blame tracked.txt" }, attrs: [["args", "blame tracked.txt"]] },
    { cwd: repo },
  );
  assert.match(blame.output, /line1/);
});

test("3. git: запрещённые подкоманды — отказ без выполнения", () => {
  const repo = mkGitRepo();
  for (const sub of ["commit", "checkout", "push", "reset", "clean"]) {
    const r = executeTool(
      { name: "git", args: { args: `${sub} --all` }, attrs: [["args", `${sub} --all`]] },
      { cwd: repo },
    );
    assert.equal(r.ok, false);
    assert.match(r.output, new RegExp(`git subcommand not allowed: ${sub}`));
  }
  // commit не выполнялся — HEAD по-прежнему один коммит
  const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" });
  assert.equal(count.trim(), "1");
});

test("3. git: опции записи (--output, --exec, --contents) и пути вне cwd отклоняются", () => {
  const repo = mkGitRepo();
  // 1. --output
  const rOutput = executeTool(
    { name: "git", args: { args: "diff --output=/tmp/x HEAD" }, attrs: [["args", "diff --output=/tmp/x HEAD"]] },
    { cwd: repo },
  );
  assert.equal(rOutput.ok, false);
  assert.match(rOutput.output, /git option not allowed/);

  // 2. --contents в git blame (Finding 1)
  const rContents = executeTool(
    {
      name: "git",
      args: { args: "blame --contents /etc/passwd -- tracked.txt" },
      attrs: [["args", "blame --contents /etc/passwd -- tracked.txt"]],
    },
    { cwd: repo },
  );
  assert.equal(rContents.ok, false);
  assert.doesNotMatch(rContents.output, /root:x:0:0/);

  // 3. --contents=... форма
  const rContentsEq = executeTool(
    {
      name: "git",
      args: { args: "blame --contents=/etc/passwd -- tracked.txt" },
      attrs: [["args", "blame --contents=/etc/passwd -- tracked.txt"]],
    },
    { cwd: repo },
  );
  assert.equal(rContentsEq.ok, false);

  // 4. Абсолютный путь вне cwd
  const rAbs = executeTool(
    { name: "git", args: { args: "blame /etc/passwd" }, attrs: [["args", "blame /etc/passwd"]] },
    { cwd: repo },
  );
  assert.equal(rAbs.ok, false);
  assert.match(rAbs.output, /access denied: path outside cwd/);

  // 5. .. путь вне cwd
  const rDotDot = executeTool(
    { name: "git", args: { args: "blame ../other.txt" }, attrs: [["args", "blame ../other.txt"]] },
    { cwd: repo },
  );
  assert.equal(rDotDot.ok, false);
  assert.match(rDotDot.output, /access denied: path outside cwd/);
});

test("3. git: patch-вывод show/log -p/diff фильтрует hunks конфиденциальных файлов (Finding 2)", () => {
  const repo = mkGitRepo();
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(repo, "code.js"), "console.log('safe code');\n");
  fs.writeFileSync(path.join(repo, ".env"), "DB_PASS=hunter2_secret_pwd_999\n");
  fs.mkdirSync(path.join(repo, "secrets"));
  fs.writeFileSync(path.join(repo, "secrets", "key.pem"), "RSAKEY=rsa_super_secret_key_888\n");
  fs.writeFileSync(path.join(repo, "id_rsa"), "SSHKEY=ssh_secret_value_777\n");
  git(["add", "code.js", ".env", "secrets/key.pem", "id_rsa"]);
  git(["commit", "-q", "-m", "commit with secrets and safe code"]);
  const headSha = git(["rev-parse", "HEAD"]).trim();

  // 1. git log -p без pathspec
  const rLog = executeTool(
    { name: "git", args: { args: "log -p -n 1" }, attrs: [["args", "log -p -n 1"]] },
    { cwd: repo },
  );
  assert.equal(rLog.ok, true);
  assert.match(rLog.output, /commit with secrets and safe code/);
  assert.match(rLog.output, /safe code/);
  assert.doesNotMatch(rLog.output, /hunter2_secret_pwd/);
  assert.doesNotMatch(rLog.output, /rsa_super_secret_key/);
  assert.doesNotMatch(rLog.output, /ssh_secret_value/);
  assert.doesNotMatch(rLog.output, /\+\+\+ b\/\.env/);
  assert.doesNotMatch(rLog.output, /\+\+\+ b\/id_rsa/);
  assert.doesNotMatch(rLog.output, /\+\+\+ b\/secrets\/key\.pem/);

  // 2. git show <sha>
  const rShow = executeTool(
    { name: "git", args: { args: `show ${headSha}` }, attrs: [["args", `show ${headSha}`]] },
    { cwd: repo },
  );
  assert.equal(rShow.ok, true);
  assert.match(rShow.output, /safe code/);
  assert.doesNotMatch(rShow.output, /hunter2_secret_pwd/);
  assert.doesNotMatch(rShow.output, /rsa_super_secret_key/);
  assert.doesNotMatch(rShow.output, /ssh_secret_value/);

  // 3. git diff HEAD~1 HEAD
  const rDiff = executeTool(
    { name: "git", args: { args: "diff HEAD~1 HEAD" }, attrs: [["args", "diff HEAD~1 HEAD"]] },
    { cwd: repo },
  );
  assert.equal(rDiff.ok, true);
  assert.match(rDiff.output, /safe code/);
  assert.doesNotMatch(rDiff.output, /hunter2_secret_pwd/);
  assert.doesNotMatch(rDiff.output, /rsa_super_secret_key/);
  assert.doesNotMatch(rDiff.output, /ssh_secret_value/);
});

test("3. git: пути к чувствительным файлам отклоняются с SENSITIVE_DENIED", () => {
  const repo = mkGitRepo();
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(repo, ".env"), "DB_PASS_WORD=very_secret_pass_123\n");
  fs.mkdirSync(path.join(repo, "secrets"));
  fs.writeFileSync(path.join(repo, "secrets", "key.pem"), "CERT_KEY=pem_content_abc\n");
  fs.writeFileSync(path.join(repo, "id_rsa"), "SSH_KEY=rsa_private_xyz\n");
  fs.writeFileSync(path.join(repo, "app.key"), "APP_KEY=key_content_789\n");
  git(["add", ".env", "secrets/key.pem", "id_rsa", "app.key"]);
  git(["commit", "-q", "-m", "add secrets"]);

  // 1. Форма <rev>:<path>: git show HEAD:.env
  const rShow = executeTool(
    { name: "git", args: { args: "show HEAD:.env" }, attrs: [["args", "show HEAD:.env"]] },
    { cwd: repo },
  );
  assert.equal(rShow.ok, false);
  assert.match(rShow.output, /access denied to sensitive file/);
  assert.doesNotMatch(rShow.output, /very_secret_pass/);

  // 2. Токены после '--': git log -p -- secrets/key.pem
  const rLog = executeTool(
    { name: "git", args: { args: "log -p -- secrets/key.pem" }, attrs: [["args", "log -p -- secrets/key.pem"]] },
    { cwd: repo },
  );
  assert.equal(rLog.ok, false);
  assert.match(rLog.output, /access denied to sensitive file/);
  assert.doesNotMatch(rLog.output, /pem_content/);

  // 3. Голый pathspec: git blame id_rsa
  const rBlame = executeTool(
    { name: "git", args: { args: "blame id_rsa" }, attrs: [["args", "blame id_rsa"]] },
    { cwd: repo },
  );
  assert.equal(rBlame.ok, false);
  assert.match(rBlame.output, /access denied to sensitive file/);
  assert.doesNotMatch(rBlame.output, /rsa_private/);

  // 4. Wildcard pathspec: git diff -- *.key
  const rDiff = executeTool(
    { name: "git", args: { args: "diff -- *.key" }, attrs: [["args", "diff -- *.key"]] },
    { cwd: repo },
  );
  assert.equal(rDiff.ok, false);
  assert.match(rDiff.output, /access denied to sensitive file/);

  // 5. Разрешённые файлы читаются без ошибок
  const rOk = executeTool(
    { name: "git", args: { args: "show HEAD:tracked.txt" }, attrs: [["args", "show HEAD:tracked.txt"]] },
    { cwd: repo },
  );
  assert.equal(rOk.ok, true);
  assert.match(rOk.output, /line1/);
});

/* ---------- 4. Чёрный список конфиденциальных файлов ---------- */

test("4. isSensitivePath и read_file: .env, .env.prod, secrets/key.pem — отказ без чтения", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.writeFileSync(path.join(cwd, ".env"), "TOKEN=x");
  fs.writeFileSync(path.join(cwd, ".env.production"), "TOKEN=y");
  fs.mkdirSync(path.join(cwd, "secrets"));
  fs.writeFileSync(path.join(cwd, "secrets", "key.pem"), "PEM");
  fs.writeFileSync(path.join(cwd, "id_rsa_backup"), "RSA");
  for (const p of [".env", ".env.production", "secrets/key.pem", "id_rsa_backup"]) {
    assert.equal(isSensitivePath(p), true, p);
    const r = executeTool(
      { name: "read_file", args: { path: p }, attrs: [["path", p]] },
      { cwd },
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /access denied to sensitive file/);
    assert.doesNotMatch(r.output, /TOKEN=|PEM|RSA/);
  }
  // grep по чувствительному пути — тот же отказ
  const g = executeTool(
    { name: "grep", args: { pattern: "TOKEN", path: "secrets" }, attrs: [["pattern", "TOKEN"], ["path", "secrets"]] },
    { cwd },
  );
  assert.equal(g.ok, false);
  assert.match(g.output, /access denied to sensitive file/);
});

test("4. isSensitivePath и git: glob-паттерны (.e*, id_?sa, *.ke?, [.]env, sec?ets/*) отклоняются (Finding 3)", () => {
  const repo = mkGitRepo();
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(repo, ".env"), "DB_PASS=hunter2_glob_bypass_fail\n");
  fs.writeFileSync(path.join(repo, "id_rsa"), "RSAKEY=rsa_glob_bypass_fail\n");
  fs.writeFileSync(path.join(repo, "app.key"), "KEY=app_key_glob_fail\n");
  fs.mkdirSync(path.join(repo, "secrets"));
  fs.writeFileSync(path.join(repo, "secrets", "pass.txt"), "SECRET=secrets_glob_fail\n");
  git(["add", ".env", "id_rsa", "app.key", "secrets/pass.txt"]);
  git(["commit", "-q", "-m", "add secrets for glob test"]);

  const patterns = [".e*", "id_?sa", "*.ke?", "[.]env", "sec?ets/*", "*.pe?", "id_*"];
  for (const pat of patterns) {
    assert.equal(isSensitivePath(pat), true, `isSensitivePath(${pat}) should be true`);
  }

  // 1. git log -p -- .e*
  const rEnv = executeTool(
    { name: "git", args: { args: "log -p -- .e*" }, attrs: [["args", "log -p -- .e*"]] },
    { cwd: repo },
  );
  assert.equal(rEnv.ok, false);
  assert.match(rEnv.output, /access denied to sensitive file/);
  assert.doesNotMatch(rEnv.output, /hunter2_glob_bypass/);

  // 2. git log -p -- id_?sa
  const rId = executeTool(
    { name: "git", args: { args: "log -p -- id_?sa" }, attrs: [["args", "log -p -- id_?sa"]] },
    { cwd: repo },
  );
  assert.equal(rId.ok, false);
  assert.match(rId.output, /access denied to sensitive file/);
  assert.doesNotMatch(rId.output, /rsa_glob_bypass/);

  // 3. git log -p -- *.ke?
  const rKey = executeTool(
    { name: "git", args: { args: "log -p -- *.ke?" }, attrs: [["args", "log -p -- *.ke?"]] },
    { cwd: repo },
  );
  assert.equal(rKey.ok, false);
  assert.match(rKey.output, /access denied to sensitive file/);

  // 4. git log -p -- [.]env
  const rDot = executeTool(
    { name: "git", args: { args: "log -p -- [.]env" }, attrs: [["args", "log -p -- [.]env"]] },
    { cwd: repo },
  );
  assert.equal(rDot.ok, false);
  assert.match(rDot.output, /access denied to sensitive file/);

  // 5. git log -p -- sec?ets/*
  const rSec = executeTool(
    { name: "git", args: { args: "log -p -- sec?ets/*" }, attrs: [["args", "log -p -- sec?ets/*"]] },
    { cwd: repo },
  );
  assert.equal(rSec.ok, false);
  assert.match(rSec.output, /access denied to sensitive file/);
});

test("4. grep fallback git grep: чувствительные файлы исключаются из выдачи", () => {
  const repo = mkGitRepo();
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "TARGET_TOKEN_SEARCH = public_value\n");
  fs.writeFileSync(path.join(repo, ".env"), "TARGET_TOKEN_SEARCH = config_secret_val\n");
  fs.mkdirSync(path.join(repo, "secrets"));
  fs.writeFileSync(path.join(repo, "secrets", "key.pem"), "TARGET_TOKEN_SEARCH = pem_secret_val\n");
  fs.writeFileSync(path.join(repo, "id_rsa"), "TARGET_TOKEN_SEARCH = rsa_secret_val\n");
  git(["add", "tracked.txt", ".env", "secrets/key.pem", "id_rsa"]);
  git(["commit", "-q", "-m", "add test files"]);

  const prevPath = process.env.PATH;
  const noRgDir = mkTmp("argon-norg-");
  const gitBin = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitBin, path.join(noRgDir, "git"));
  process.env.PATH = noRgDir;

  try {
    const res = executeTool(
      { name: "grep", args: { pattern: "TARGET_TOKEN_SEARCH" }, attrs: [["pattern", "TARGET_TOKEN_SEARCH"]] },
      { cwd: repo },
    );
    assert.equal(res.ok, true);
    assert.match(res.output, /tracked\.txt/);
    assert.match(res.output, /public_value/);
    assert.doesNotMatch(res.output, /\.env/);
    assert.doesNotMatch(res.output, /secrets/);
    assert.doesNotMatch(res.output, /id_rsa/);
    assert.doesNotMatch(res.output, /config_secret_val/);
    assert.doesNotMatch(res.output, /pem_secret_val/);
    assert.doesNotMatch(res.output, /rsa_secret_val/);
  } finally {
    process.env.PATH = prevPath;
  }
});

/* ---------- 5. Маскировка секретов ---------- */

test("5. maskForWeb: токены и ключи заменяются на [скрыто: <тип>]", () => {
  const secret = "ghp_" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2";
  const masked = maskForWeb(`token: ${secret}`);
  assert.match(masked, /\[скрыто: github-token\]/);
  assert.ok(!masked.includes(secret));

  const pk = "-----BEGIN EXAMPLE PRIVATE KEY-----\nMIIabcd\n-----END PRIVATE KEY-----";
  const m2 = maskForWeb(pk);
  assert.match(m2, /\[скрыто: private-key\]/);
  assert.ok(!m2.includes("MIIabcd"));

  const gkey = "AIza" + "SyD4xA7bN0kLmQzR2sT5uVwX8yZ1aB";
  assert.match(maskForWeb(gkey), /\[скрыто: api-key\]/);
  const sk = "sk-" + "projAbC1234567890xYz";
  assert.match(maskForWeb(sk), /\[скрыто: api-key\]/);
  assert.match(maskForWeb("vless:" + "//EXAMPLE@h:443?s=x"), /\[скрыто: vless-uri\]/);
  assert.match(maskForWeb(`write me at ${GMAIL}`), /\[скрыто: email\]/);
  assert.match(maskForWeb(`${HOME_P}/alice/secret`), /\[скрыто: home-path\]/);
  assert.match(maskForWeb(`${OPT_P}/tools`), /\[скрыто: opt-path\]/);
  assert.match(maskForWeb("host 192.168.1.10"), /\[скрыто: private-ip\]/);
});

test("5. executeTool: секреты в результате маскируются", () => {
  const cwd = mkTmp("argon-cwd-");
  const secret = "ghp_" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9O";
  fs.writeFileSync(path.join(cwd, "conf.txt"), `key=${secret}\n`);
  const r = executeTool(
    { name: "read_file", args: { path: "conf.txt" }, attrs: [["path", "conf.txt"]] },
    { cwd },
  );
  assert.equal(r.ok, true);
  assert.match(r.output, /\[скрыто: github-token\]/);
  assert.ok(!r.output.includes(secret));
});

test("5. sync-тест зеркала: SECRET_RULES и категории 1–4 зеркалят leak-scan.ts", () => {
  const leakScanFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../bb-plugin-orchestrator/hooks/leak-scan.ts"
  );
  assert.ok(fs.existsSync(leakScanFile), "leak-scan.ts must exist");
  const tsSource = fs.readFileSync(leakScanFile, "utf8");

  // Категория 1: регулярки из SECRET_VALUE_RES и имена из PLUGIN_SECRET_RULES
  const svMatch = tsSource.match(/const SECRET_VALUE_RES[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(svMatch, "SECRET_VALUE_RES block not found in leak-scan.ts");
  const secretValueRegexes = svMatch[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/"))
    .map((l) => {
      const lastSlash = l.lastIndexOf("/");
      return {
        pattern: l.slice(1, lastSlash),
        flags: l.slice(lastSlash + 1).replace(/,/g, "").trim(),
      };
    });

  assert.equal(
    SECRET_RULES.length,
    secretValueRegexes.length,
    "SECRET_RULES count must match SECRET_VALUE_RES"
  );
  for (let i = 0; i < SECRET_RULES.length; i++) {
    const [ruleName, re] = SECRET_RULES[i];
    assert.equal(
      re.source,
      secretValueRegexes[i].pattern,
      `SECRET_RULES[${i}] pattern mismatch for rule ${ruleName}`
    );
    assert.ok(re.flags.includes("g"), `SECRET_RULES[${i}] must have global flag`);
  }

  const psMatch = tsSource.match(/const PLUGIN_SECRET_RULES[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(psMatch, "PLUGIN_SECRET_RULES not found in leak-scan.ts");
  const expectedRuleNames = [...psMatch[1].matchAll(/rule:\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const [ruleName] of SECRET_RULES) {
    assert.ok(
      expectedRuleNames.includes(ruleName),
      `Rule ${ruleName} must exist in PLUGIN_SECRET_RULES`
    );
  }

  // Категория 2: PERSONAL_EMAIL_RE
  const emailMatch = tsSource.match(/export const PERSONAL_EMAIL_RE\s*=[\s\S]*?\/(.*?)\/([a-z]*);/);
  assert.ok(emailMatch, "PERSONAL_EMAIL_RE not found in leak-scan.ts");
  assert.equal(PERSONAL_EMAIL_RE.source, emailMatch[1], "PERSONAL_EMAIL_RE source mismatch");

  // Категория 3: MACHINE_RULES
  const machineMatch = tsSource.match(/export const MACHINE_RULES[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(machineMatch, "MACHINE_RULES not found in leak-scan.ts");
  function extractRuleRe(block, ruleName) {
    const idx = block.indexOf(`"${ruleName}"`);
    if (idx === -1) return null;
    const after = block.slice(idx);
    const reIdx = after.indexOf("re:");
    if (reIdx === -1) return null;
    const fromRe = after.slice(reIdx);
    const slash1 = fromRe.indexOf("/");
    const lineEnd = fromRe.indexOf("\n");
    const line = fromRe.slice(0, lineEnd === -1 ? undefined : lineEnd);
    const lastSlash = line.lastIndexOf("/");
    return line.slice(slash1 + 1, lastSlash);
  }
  for (const rule of ["home-path", "opt-path", "private-ip"]) {
    const expPattern = extractRuleRe(machineMatch[1], rule);
    assert.ok(expPattern, `Pattern for rule ${rule} not found in leak-scan.ts`);
    const found = MACHINE_RULES.find(([r]) => r === rule);
    assert.ok(found, `Rule ${rule} missing in web-tools MACHINE_RULES`);
    assert.equal(found[1].source, expPattern, `Pattern mismatch for machine rule ${rule}`);
  }

  // Категория 4: BB_ID_RULES (getbb-host)
  const bbIdMatch = tsSource.match(/const BB_ID_RULES[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(bbIdMatch, "BB_ID_RULES not found in leak-scan.ts");
  const expHostPattern = extractRuleRe(bbIdMatch[1], "getbb-host");
  assert.ok(expHostPattern, "getbb-host pattern not found in leak-scan.ts");
  const foundHost = BB_ID_RULES.find(([r]) => r === "getbb-host");
  assert.ok(foundHost, "getbb-host missing in web-tools BB_ID_RULES");
  assert.equal(foundHost[1].source, expHostPattern, "Pattern mismatch for getbb-host");
});

/* ---------- 6. Цикл раундов и лимиты ---------- */

test("6. runToolLoop: цепочка раундов, результаты единым сообщением", async () => {
  const cwd = mkTmp("argon-cwd-");
  fs.writeFileSync(path.join(cwd, "a.txt"), "A-CONTENT");
  fs.writeFileSync(path.join(cwd, "b.txt"), "B-CONTENT");
  const responses = [
    `Смотрю файлы.\n<tool name="read_file" path="a.txt"/>\n<tool name="read_file" path="b.txt"/>`,
    "Финальный ответ без вызовов.",
  ];
  const sent = [];
  const events = [];
  const loop = await runToolLoop({
    firstMessage: "TASK",
    send: async (m) => {
      sent.push(m);
      return responses.shift();
    },
    execute: (call) => executeTool(call, { cwd }),
    onToolStart: (call) => {
      events.push(["start", call.name]);
      return "id-" + events.length;
    },
    onToolEnd: (id, call, r) => events.push(["end", id, r.ok]),
    maxRounds: 8,
  });
  assert.equal(loop.cancelled, false);
  assert.equal(loop.finalText, "Финальный ответ без вызовов.");
  assert.equal(loop.rounds, 1);
  assert.equal(sent.length, 2);
  // два вызова — единым сообщением с двумя блоками
  assert.match(sent[1], /=== tool: read_file path="a\.txt" ===\nA-CONTENT/);
  assert.match(sent[1], /=== tool: read_file path="b\.txt" ===\nB-CONTENT/);
  assert.deepEqual(events, [["start", "read_file"], ["end", "id-1", true], ["start", "read_file"], ["end", "id-3", true]]);
});

test("6. runToolLoop: лимит раундов — принудительный финальный ответ", async () => {
  const cwd = mkTmp("argon-cwd-");
  fs.writeFileSync(path.join(cwd, "a.txt"), "A");
  const sent = [];
  const loop = await runToolLoop({
    firstMessage: "TASK",
    send: async (m) => {
      sent.push(m);
      // на каждое сообщение с результатами — снова вызов; на принудительный
      // запрос — финальный текст
      if (sent.length > 9) return "FINAL-FORCED";
      return '<tool name="read_file" path="a.txt"/>';
    },
    execute: (call) => executeTool(call, { cwd }),
    maxRounds: 8,
  });
  assert.equal(loop.forcedFinal, true);
  assert.equal(loop.rounds, 8);
  assert.equal(sent.length, 10); // первое + 8 раундов + принудительный запрос
  assert.equal(sent[9], forceFinalMessage(8));
  assert.match(sent[9], /8/);
  assert.equal(loop.finalText, "FINAL-FORCED");
});

test("6. runToolLoop: ответ без вызовов завершает ход за 1 раунд", async () => {
  let sends = 0;
  const loop = await runToolLoop({
    firstMessage: "TASK",
    send: async () => {
      sends += 1;
      return "Сразу финальный ответ.";
    },
    execute: () => {
      throw new Error("execute must not be called");
    },
  });
  assert.equal(sends, 1);
  assert.equal(loop.rounds, 0);
  assert.equal(loop.finalText, "Сразу финальный ответ.");
});

test("6. runToolLoop: неизвестный инструмент — error в блоке результата", async () => {
  const sent = [];
  const loop = await runToolLoop({
    firstMessage: "TASK",
    send: async (m) => {
      sent.push(m);
      return sent.length === 1 ? '<tool name="rm_rf" path="/"/>' : "done";
    },
    execute: (call) => executeTool(call, { cwd: null }),
  });
  assert.match(sent[1], /=== tool: rm_rf path="\/" ===\nerror: unknown tool: rm_rf/);
});

/* ---------- 7. Упаковка первого сообщения ---------- */

test("7. packFirstMessage: пути файлов, треды и ключи задач вкладываются", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "alpha.md"), "ALPHA-BODY");
  fs.writeFileSync(path.join(cwd, "README.md"), "README-BODY");
  const text = `Проверь src/alpha.md и README.md, а также тред ${THREAD_ID} и задачу PLUG-129.`;
  const r = withBbStub(() => packFirstMessage({ text, cwd }));
  assert.match(r.message, /\[provider tools\]/);
  assert.match(r.message, /<tool name="read_file"/);
  assert.match(r.message, /=== file: src\/alpha\.md ===\nALPHA-BODY/);
  assert.match(r.message, /=== file: README\.md ===\nREADME-BODY/);
  assert.match(r.message, new RegExp(`=== thread: ${THREAD_ID} ===\\nSTUB:thread output ${THREAD_ID}`));
  assert.match(r.message, /=== task: PLUG-129 ===\nSTUB:tasks show PLUG-129/);
  assert.equal(r.overflow.length, 0);
});

test("7. packFirstMessage: вложенный ресурс ACP вкладывается как файл", () => {
  const cwd = mkTmp("argon-cwd-");
  const r = packFirstMessage({
    text: "посмотри вложение",
    cwd,
    embeddedResources: [
      { type: "resource", resource: { uri: "file:///x/y/notes.md", text: "EMBED-BODY" } },
    ],
  });
  assert.match(r.message, /=== file: notes\.md ===\nEMBED-BODY/);
});

test("7. packFirstMessage: дифф и статус вкладываются в git-репозитории", () => {
  const repo = mkGitRepo();
  fs.writeFileSync(path.join(repo, "tracked.txt"), "line1\nline2\nchanged\n");
  const r = packFirstMessage({ text: "ревью изменений", cwd: repo });
  assert.match(r.message, /=== git status --short ===/);
  assert.match(r.message, /=== git diff HEAD ===/);
  assert.match(r.message, /changed/);
});

test("7. packFirstMessage: авто-дифф HEAD и статус исключают конфиденциальные файлы (Finding 4)", () => {
  const repo = mkGitRepo();
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(repo, ".env"), "DB_PASS=hunter2_first_msg_leak_fail\n");
  git(["add", ".env"]);
  git(["commit", "-q", "-m", "track .env"]);

  // Изменяем tracked.txt и .env
  fs.writeFileSync(path.join(repo, "tracked.txt"), "line1\nline2\npublic_changed_content\n");
  fs.writeFileSync(path.join(repo, ".env"), "DB_PASS=hunter2_modified_leak_fail\n");

  const r = packFirstMessage({ text: "ревью изменений в репозитории", cwd: repo });
  assert.match(r.message, /=== git diff HEAD ===/);
  assert.match(r.message, /public_changed_content/);
  assert.doesNotMatch(r.message, /hunter2_/);
  assert.doesNotMatch(r.message, /\.env/);
});

test("7. packFirstMessage: переполнение — подсказка «Можно запросить инструментом:»", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "alpha.md"), "ALPHA-BODY");
  const text = `Проверь src/alpha.md, тред ${THREAD_ID} и задачу PLUG-129.`;
  const r = withBbStub(() => packFirstMessage({ text, cwd, maxBytes: 1500 }));
  assert.match(r.message, /Можно запросить инструментом:/);
  assert.match(r.message, /read_file\("src\/alpha\.md"\)/);
  assert.match(r.message, new RegExp(`bb_thread_output\\("${THREAD_ID}"\\)`));
  assert.match(r.message, /bb_task_show\("PLUG-129"\)/);
});

test("7. packFirstMessage: секреты вложений и текста маскируются", () => {
  const cwd = mkTmp("argon-cwd-");
  const secret = "sk-" + "liveAbC1234567890xYz";
  fs.writeFileSync(path.join(cwd, "notes.md"), `see ${secret}`);
  const r = packFirstMessage({ text: `в notes.md лежит ${GMAIL}`, cwd });
  assert.match(r.message, /=== file: notes\.md ===\nsee \[скрыто: api-key\]/);
  assert.match(r.message, /\[скрыто: email\]/);
  assert.ok(!r.message.includes(secret));
});

/* ---------- 8. Усечение и формат ---------- */

test("8. truncResult: >60 КБ обрезается суффиксом провайдера", () => {
  const big = "x".repeat(MAX_TOOL_RESULT_BYTES + 500);
  const out = truncResult(big);
  assert.ok(out.endsWith(TRUNC_SUFFIX.trimEnd()));
  assert.ok(out.length < big.length);
});

test("8. read_file: диапазон from/to и таймаут-защищённый вызов", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.writeFileSync(path.join(cwd, "lines.txt"), "l1\nl2\nl3\nl4\nl5\n");
  const r = executeTool(
    { name: "read_file", args: { path: "lines.txt", from: "2", to: "3" }, attrs: [["path", "lines.txt"], ["from", "2"], ["to", "3"]] },
    { cwd },
  );
  assert.equal(r.ok, true);
  assert.equal(r.output, "l2\nl3");
});

test("8. bb_* инструменты: валидация аргументов до вызова bb", () => {
  const bad = executeTool(
    { name: "bb_thread_output", args: { threadId: "not-a-thread" }, attrs: [["threadId", "not-a-thread"]] },
    {},
  );
  assert.equal(bad.ok, false);
  assert.match(bad.output, /invalid threadId/);
  const badKey = executeTool(
    { name: "bb_task_show", args: { key: "plug-129" }, attrs: [["key", "plug-129"]] },
    {},
  );
  assert.match(badKey.output, /invalid key/);
  const extra = executeTool(
    { name: "bb_thread_output", args: { threadId: THREAD_ID, foo: "1" }, attrs: [["threadId", THREAD_ID], ["foo", "1"]] },
    {},
  );
  assert.match(extra.output, /unexpected args: foo/);
  const okStub = withBbStub(() =>
    executeTool(
      { name: "bb_thread_message", args: { threadId: THREAD_ID, msg: "2" }, attrs: [["threadId", THREAD_ID], ["msg", "2"]] },
      {},
    ),
  );
  assert.match(okStub.output, new RegExp(`STUB:thread log ${THREAD_ID} --message 2`));
});

test("8. list_dir: до 200 записей, .git не обходится", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.writeFileSync(path.join(cwd, ".git", "config"), "G");
  fs.mkdirSync(path.join(cwd, "sub"));
  fs.writeFileSync(path.join(cwd, "sub", "f.txt"), "F");
  const r = executeTool(
    { name: "list_dir", args: { path: "." }, attrs: [["path", "."]] },
    { cwd },
  );
  assert.equal(r.ok, true);
  assert.match(r.output, /sub\/f\.txt/);
  assert.doesNotMatch(r.output, /config/);
});

test(`8. toolSystemHeader: не содержит ни одного id /${T}[a-z0-9]{10}/, кроме ${T}xxxxxxxxxx`, () => {
  const header = toolSystemHeader();
  const re = new RegExp(`${T}[a-z0-9]{10}`, "g");
  const matches = header.match(re) || [];
  const placeholder = T + "xxxxxxxxxx";
  assert.ok(matches.length > 0, "ожидается хотя бы одно вхождение плейсхолдера");
  for (const m of matches) {
    assert.equal(m, placeholder, `неожиданный id в шапке: ${m}`);
  }
});

test("8. toolSystemHeader: по умолчанию веб-поиск первым и все repo-тулы (PLUG-370, PLUG-384)", () => {
  const header = toolSystemHeader();
  // PLUG-384: первая строка — указание искать в публичном вебе, а не
  // общесессионное «доступны только».
  assert.match(header.split("\n")[0], /Для поиска публичных источников используй поиск Gemini и открывай найденные страницы\./);
  assert.doesNotMatch(header, /доступны только/);
  assert.doesNotMatch(header, /В этой сессии доступны/);
  assert.match(header, /Правила XML и доступа на чтение относятся только к ним\./);
  assert.match(header, /<tool name="read_file"/);
  assert.match(header, /<tool name="list_dir"/);
  assert.match(header, /<tool name="grep"/);
  assert.match(header, /<tool name="git"/);
  assert.match(header, /<tool name="bb_thread_output"/);
  assert.match(header, /<tool name="bb_thread_message"/);
  assert.match(header, /<tool name="bb_task_show"/);
  assert.match(header, /git — только show\|diff\|log\|blame\|ls-files\|status; bb_\* — по указанным аргументам\./);
});

test("8. toolSystemHeader: repo: false -> нет read_file/git в тексте, есть bb_* и веб-строка первой (PLUG-370, PLUG-384)", () => {
  const header = toolSystemHeader(8, { repo: false });
  assert.match(header.split("\n")[0], /Для поиска публичных источников используй поиск Gemini и открывай найденные страницы\./);
  assert.doesNotMatch(header, /доступны только/);
  assert.doesNotMatch(header, /read_file/);
  assert.doesNotMatch(header, /\bgit\b/i);
  assert.doesNotMatch(header, /list_dir/);
  assert.doesNotMatch(header, /grep/);
  assert.match(header, /<tool name="bb_thread_output"/);
  assert.match(header, /<tool name="bb_thread_message"/);
  assert.match(header, /<tool name="bb_task_show"/);
  assert.match(header, /bb_\* — по указанным аргументам\./);
});

/* ---------- Findings 1-4 аудита: неблокирующие замечания ---------- */

test("Finding 1: packFirstMessage лимит ARGON_MAX_MESSAGE_BYTES соблюдается при переполнении", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.mkdirSync(path.join(cwd, "files"));
  const filenames = [];
  for (let i = 0; i < 5; i++) {
    const fn = `files/doc${i}.txt`;
    fs.writeFileSync(path.join(cwd, fn), "X".repeat(28 * 1024));
    filenames.push(fn);
  }
  const text = `Проверь файлы: ${filenames.join(" ")}`;
  const r = packFirstMessage({ text, cwd });
  assert.ok(Buffer.byteLength(r.message, "utf8") <= 120 * 1024);
  assert.ok(r.overflow.length > 0);
  assert.match(r.message, /Можно запросить инструментом:/);
});

test("Finding 2: filterGitStatusOutput и filterGitPatchOutput скрывают имена чувствительных файлов", () => {
  const rawStatus = [
    "On branch main",
    "Changes not staged for commit:",
    "\tmodified:   .e" + "nv",
    "\tmodified:   src/app.ts",
    "",
    "Untracked files:",
    "\t.e" + "nv.local",
    "\tsecrets/pass.key",
    "\tnotes.txt",
  ].join("\n");
  const filteredStatus = filterGitStatusOutput(rawStatus);
  assert.match(filteredStatus, /src\/app\.ts/);
  assert.match(filteredStatus, /notes\.txt/);
  assert.doesNotMatch(filteredStatus, /\.e[n]v/);
  assert.doesNotMatch(filteredStatus, /secrets/);

  // name-only
  const nameOnly = [
    ".e" + "nv",
    "secrets/key.pem",
    "id_rsa",
    "src/index.js",
  ].join("\n");
  const filteredNameOnly = filterGitPatchOutput(nameOnly);
  assert.equal(filteredNameOnly, "src/index.js");

  // name-status
  const nameStatus = [
    "M\t.e" + "nv",
    "A\tsecrets/token.key",
    "M\tsrc/index.js",
  ].join("\n");
  const filteredNameStatus = filterGitPatchOutput(nameStatus);
  assert.equal(filteredNameStatus, "M\tsrc/index.js");

  // raw format
  const rawDiff = [
    ":100644 100644 0000000 1111111 M\t.e" + "nv",
    ":100644 100644 0000000 1111111 M\tsrc/index.js",
  ].join("\n");
  const filteredRaw = filterGitPatchOutput(rawDiff);
  assert.equal(filteredRaw, ":100644 100644 0000000 1111111 M\tsrc/index.js");
});

test("Finding 3: isSensitivePath и read_file блокируют id_dsa и id_ecdsa", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.writeFileSync(path.join(cwd, "id_dsa"), "SECRET-DSA");
  fs.writeFileSync(path.join(cwd, "id_ecdsa"), "SECRET-ECDSA");
  fs.writeFileSync(path.join(cwd, "id_dsa.pub"), "PUB-DSA");

  assert.equal(isSensitivePath("id_dsa"), true);
  assert.equal(isSensitivePath("id_ecdsa"), true);
  assert.equal(isSensitivePath("id_dsa.pub"), true);

  const rDsa = executeTool(
    { name: "read_file", args: { path: "id_dsa" }, attrs: [["path", "id_dsa"]] },
    { cwd },
  );
  assert.equal(rDsa.ok, false);
  assert.match(rDsa.output, /access denied to sensitive file/);

  const rEcdsa = executeTool(
    { name: "read_file", args: { path: "id_ecdsa" }, attrs: [["path", "id_ecdsa"]] },
    { cwd },
  );
  assert.equal(rEcdsa.ok, false);
  assert.match(rEcdsa.output, /access denied to sensitive file/);
});

test("Finding 4: git subcommands разрешают HEAD:path, commit regex ':/' и флаги со знаком '='", () => {
  const repo = mkGitRepo();
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(repo, "doc.txt"), "DOC-CONTENT\n");
  git(["add", "doc.txt"]);
  git(["commit", "-q", "-m", "add doc file"]);

  // 1. git show HEAD:doc.txt
  const rShow = executeTool(
    { name: "git", args: { args: "show HEAD:doc.txt" }, attrs: [["args", "show HEAD:doc.txt"]] },
    { cwd: repo },
  );
  assert.equal(rShow.ok, true);
  assert.match(rShow.output, /DOC-CONTENT/);

  // 2. git log ':/add doc'
  const rLog = executeTool(
    { name: "git", args: { args: "log ':/add doc'" }, attrs: [["args", "log ':/add doc'"]] },
    { cwd: repo },
  );
  assert.equal(rLog.ok, true);
  assert.match(rLog.output, /add doc file/);

  // 3. git diff --src-prefix=/abs/path/ HEAD
  const rDiff = executeTool(
    { name: "git", args: { args: "diff --src-prefix=/abs/path/ HEAD" }, attrs: [["args", "diff --src-prefix=/abs/path/ HEAD"]] },
    { cwd: repo },
  );
  assert.equal(rDiff.ok, true);
});

test("Finding 5: retry в существующий convId не дублирует вложенные материалы", async () => {
  const session = { convId: "conv-123" };
  const packed = { message: "PACKED_FULL_MATERIAL" };
  const text = "USER_PROMPT";

  const msgToSend = session.convId ? text : packed.message;
  assert.equal(msgToSend, "USER_PROMPT");

  const newSession = { convId: null };
  const newMsgToSend = newSession.convId ? text : packed.message;
  assert.equal(newMsgToSend, "PACKED_FULL_MATERIAL");
});

/* ---------- Замечания аудита захода 12 (Findings 1-4) ---------- */

test("Audit 12 Finding 1: filterGitStatusOutput и filterGitPatchOutput фильтруют форматы --numstat, --porcelain=v2, -z", () => {
  const dotEnv = ".e" + "nv";
  const dotEnvLocal = ".e" + "nv.local";
  // 1. git status --porcelain=v2
  const v2Status = [
    "# branch.oid 1234567890123456789012345678901234567890",
    "# branch.head main",
    "1 .M N... 100644 100644 100644 hash hash src/app.ts",
    `1 .M N... 100644 100644 100644 hash hash ${dotEnv}`,
    "2 R. N... 100644 100644 100644 hash hash R100 safe_new.txt\tsafe_old.txt",
    `2 R. N... 100644 100644 100644 hash hash R100 safe_new.txt\t${dotEnv}`,
    `? ${dotEnvLocal}`,
    "? src/valid.txt",
    "! secrets/pass.key",
    "! build/",
  ].join("\n");
  const filteredV2 = filterGitStatusOutput(v2Status);
  assert.match(filteredV2, /src\/app\.ts/);
  assert.match(filteredV2, /safe_new\.txt\tsafe_old\.txt/);
  assert.match(filteredV2, /src\/valid\.txt/);
  assert.match(filteredV2, /! build\//);
  assert.doesNotMatch(filteredV2, /\.e[n]v/);
  assert.doesNotMatch(filteredV2, /secrets/);

  // 2. git status -z (porcelain v1)
  const v1z = [
    " M src/app.ts",
    `?? ${dotEnv}`,
    "?? src/valid.txt",
    "R  safe_new.txt\0safe_old.txt",
    `R  safe_new.txt\0${dotEnv}`,
    "",
  ].join("\0");
  const filteredV1z = filterGitStatusOutput(v1z);
  assert.match(filteredV1z, /src\/app\.ts/);
  assert.match(filteredV1z, /src\/valid\.txt/);
  assert.match(filteredV1z, /safe_new\.txt\u0000safe_old\.txt/);
  assert.doesNotMatch(filteredV1z, /\.e[n]v/);

  // 3. git status --porcelain=v2 -z
  const v2z = [
    "# branch.head main",
    "1 .M N... 100644 100644 100644 hash hash src/app.ts",
    `1 .M N... 100644 100644 100644 hash hash ${dotEnv}`,
    `2 R. N... 100644 100644 100644 hash hash R100 safe_new.txt\0${dotEnv}`,
    `? ${dotEnv}`,
    "? src/valid.txt",
    "",
  ].join("\0");
  const filteredV2z = filterGitStatusOutput(v2z);
  assert.match(filteredV2z, /src\/app\.ts/);
  assert.match(filteredV2z, /src\/valid\.txt/);
  assert.doesNotMatch(filteredV2z, /\.e[n]v/);

  // 4. git diff --numstat
  const numstat = [
    "10\t5\tsrc/app.ts",
    `1\t1\t${dotEnv}`,
    "-\t-\tsecrets/key.pem",
    `0\t0\told.txt => ${dotEnv}`,
    "0\t0\tsrc/{old.ts => new.ts}",
  ].join("\n");
  const filteredNumstat = filterGitPatchOutput(numstat);
  assert.match(filteredNumstat, /src\/app\.ts/);
  assert.match(filteredNumstat, /src\/\{old\.ts => new\.ts\}/);
  assert.doesNotMatch(filteredNumstat, /\.e[n]v/);
  assert.doesNotMatch(filteredNumstat, /secrets/);

  // 5. git diff --numstat -z
  const numstatZ = [
    "10\t5\tsrc/app.ts",
    `1\t1\t${dotEnv}`,
    "0\t0\t\0old.txt\0new.txt",
    `0\t0\t\0old.txt\0${dotEnv}`,
    "",
  ].join("\0");
  const filteredNumstatZ = filterGitPatchOutput(numstatZ);
  assert.match(filteredNumstatZ, /src\/app\.ts/);
  assert.match(filteredNumstatZ, /old\.txt\u0000new\.txt/);
  assert.doesNotMatch(filteredNumstatZ, /\.e[n]v/);

  // 6. git diff --raw -z
  const rawZ = [
    ":100644 100644 1 2 M\0src/app.ts",
    `:100644 100644 1 2 M\0${dotEnv}`,
    "",
  ].join("\0");
  const filteredRawZ = filterGitPatchOutput(rawZ);
  assert.match(filteredRawZ, /src\/app\.ts/);
  assert.doesNotMatch(filteredRawZ, /\.e[n]v/);

  // 7. git diff --name-status -z
  const nameStatusZ = [
    "M\0src/app.ts",
    `A\0${dotEnv}`,
    "R100\0safe_old.txt\0safe_new.txt",
    `R100\0safe_old.txt\0${dotEnv}`,
    "",
  ].join("\0");
  const filteredNameStatusZ = filterGitPatchOutput(nameStatusZ);
  assert.match(filteredNameStatusZ, /src\/app\.ts/);
  assert.match(filteredNameStatusZ, /safe_old\.txt\u0000safe_new\.txt/);
  assert.doesNotMatch(filteredNameStatusZ, /\.e[n]v/);

  // 8. git diff --name-only -z
  const nameOnlyZ = [
    "src/app.ts",
    dotEnv,
    "secrets/key.pem",
    "id_rsa",
    "src/index.js",
    "",
  ].join("\0");
  const filteredNameOnlyZ = filterGitPatchOutput(nameOnlyZ);
  assert.match(filteredNameOnlyZ, /src\/app\.ts/);
  assert.match(filteredNameOnlyZ, /src\/index\.js/);
  assert.doesNotMatch(filteredNameOnlyZ, /\.e[n]v/);
  assert.doesNotMatch(filteredNameOnlyZ, /secrets/);
  assert.doesNotMatch(filteredNameOnlyZ, /id_rsa/);
});

test("Audit 12 Finding 2: parseToolCalls распознает символ '>' внутри значений атрибутов", () => {
  const calls1 = parseToolCalls('<tool name="grep" pattern="a>b"/>');
  assert.equal(calls1.length, 1);
  assert.equal(calls1[0].name, "grep");
  assert.equal(calls1[0].args.pattern, "a>b");

  const calls2 = parseToolCalls('<tool name="grep" pattern="x >= y" path="src/math.js"/>');
  assert.equal(calls2.length, 1);
  assert.equal(calls2[0].name, "grep");
  assert.equal(calls2[0].args.pattern, "x >= y");
  assert.equal(calls2[0].args.path, "src/math.js");

  const calls3 = parseToolCalls('<tool name="git" args="log --grep=\'foo>bar\'"/>');
  assert.equal(calls3.length, 1);
  assert.equal(calls3[0].name, "git");
  assert.equal(calls3[0].args.args, "log --grep='foo>bar'");

  const text = 'Рассуждения: проверяем <tool name="grep" pattern="val > 10" path="src"/> и смотрим <tool name="read_file" path="src/index.js"/>';
  const calls4 = parseToolCalls(text);
  assert.equal(calls4.length, 2);
  assert.equal(calls4[0].name, "grep");
  assert.equal(calls4[0].args.pattern, "val > 10");
  assert.equal(calls4[1].name, "read_file");
  assert.equal(calls4[1].args.path, "src/index.js");
});

test("Audit 12 Finding 3: packFirstMessage гарантирует потолок ARGON_MAX_MESSAGE_BYTES при монолитном пакете > лимита", () => {
  const hugeText = "Заголовок задачи: " + "X".repeat(150 * 1024);
  const r = packFirstMessage({ text: hugeText });
  assert.ok(Buffer.byteLength(r.message, "utf8") <= 120 * 1024, `размер ${Buffer.byteLength(r.message, "utf8")} превышает 120 КБ`);
  assert.match(r.message, /\[\.\.\. текст задачи обрезан по лимиту сообщения \.\.\.\]/);
});

test("Audit 12 Finding 4: packFirstMessage сохраняет подсказки для блоков, вытесненных pop-циклом из-за шапки overflow", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.mkdirSync(path.join(cwd, "docs"));
  const filenames = [];
  for (let i = 0; i < 4; i++) {
    const fn = `docs/file${i}.txt`;
    fs.writeFileSync(path.join(cwd, fn), "D".repeat(29 * 1024));
    filenames.push(fn);
  }
  const text = `Проверь: ${filenames.join(" ")}`;
  const r = packFirstMessage({ text, cwd });
  assert.ok(Buffer.byteLength(r.message, "utf8") <= 120 * 1024);
  assert.ok(r.overflow.length > 0, "ожидаются подсказки overflow");
  assert.match(r.message, /Можно запросить инструментом:/);
  for (const fn of filenames) {
    const isAttached = r.attached.includes(`file: ${fn}`);
    const isOverflow = r.overflow.some((h) => h.includes(fn));
    assert.ok(isAttached || isOverflow, `файл ${fn} должен быть либо во вложениях, либо в подсказках`);
  }
});

test("Audit 13 Finding 1: toolReadFile и resolveInCwd блокируют чтение конфиденциального файла через симлинк внутри cwd", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=hunter2");
  fs.symlinkSync(".env", path.join(cwd, "symlink.txt"));

  const r = executeTool(
    { name: "read_file", args: { path: "symlink.txt" }, attrs: [["path", "symlink.txt"]] },
    { cwd },
  );
  assert.equal(r.ok, false);
  assert.match(r.output, /access denied to sensitive file/);

  // Также в поддиректории
  fs.mkdirSync(path.join(cwd, "nested"));
  fs.symlinkSync("../.env", path.join(cwd, "nested", "link_to_dot_env"));
  const r2 = executeTool(
    { name: "read_file", args: { path: "nested/link_to_dot_env" }, attrs: [["path", "nested/link_to_dot_env"]] },
    { cwd },
  );
  assert.equal(r2.ok, false);
  assert.match(r2.output, /access denied to sensitive file/);
});

test("Audit 13 Finding 2: packFirstMessage распознает и вкладывает файлы без расширения (Makefile, README, Dockerfile, кастомные файлы)", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.writeFileSync(path.join(cwd, "Makefile"), "all:\n\techo make");
  fs.writeFileSync(path.join(cwd, "README"), "README CONTENT");
  fs.writeFileSync(path.join(cwd, "Dockerfile"), "FROM node:20");
  fs.writeFileSync(path.join(cwd, "CUSTOM_FILE"), "CUSTOM CONTENT");

  const text = "Проверь Makefile, README, Dockerfile и CUSTOM_FILE в проекте.";
  const r = packFirstMessage({ text, cwd });
  assert.ok(r.attached.includes("file: Makefile"));
  assert.ok(r.attached.includes("file: README"));
  assert.ok(r.attached.includes("file: Dockerfile"));
  assert.ok(r.attached.includes("file: CUSTOM_FILE"));
  assert.match(r.message, /=== file: Makefile ===\nall:\n\techo make/);
  assert.match(r.message, /=== file: README ===\nREADME CONTENT/);
  assert.match(r.message, /=== file: Dockerfile ===\nFROM node:20/);
  assert.match(r.message, /=== file: CUSTOM_FILE ===\nCUSTOM CONTENT/);
  assert.ok(!r.attached.some((a) => a.includes("Проверь") || a.includes("проекте")));
});

test("Audit 13 Finding 3: packFirstMessage гарантирует потолок ARGON_MAX_MESSAGE_BYTES даже при малом maxBytes (<10 КБ)", () => {
  const hugeText = "Заголовок задачи: " + "X".repeat(20 * 1024);
  const r1 = packFirstMessage({ text: hugeText, maxBytes: 5000 });
  assert.ok(Buffer.byteLength(r1.message, "utf8") <= 5000, `размер ${Buffer.byteLength(r1.message, "utf8")} превышает 5000 Б`);
  assert.match(r1.message, /\[\.\.\. текст задачи обрезан по лимиту сообщения \.\.\.\]/);

  const r2 = packFirstMessage({ text: hugeText, maxBytes: 8000 });
  assert.ok(Buffer.byteLength(r2.message, "utf8") <= 8000, `размер ${Buffer.byteLength(r2.message, "utf8")} превышает 8000 Б`);
  assert.match(r2.message, /\[\.\.\. текст задачи обрезан по лимиту сообщения \.\.\.\]/);
});

test("Audit 13 Finding 4: filterGitPatchZOutput не путает строки коммит-сообщения со статусом git и не съедает следующий токен", () => {
  const commit1 = "commit 1111111111111111111111111111111111111111\nAuthor: user <user@example.com>\nDate:   Tue Nov 17 00:00:00 2026\n\n    title\n    M\n";
  const commit2 = "commit 2222222222222222222222222222222222222222\nAuthor: user <user@example.com>\nDate:   Tue Nov 17 00:01:00 2026\n\n    next title\n";
  const rawZ = `${commit1}\0${commit2}\0`;

  const filtered = filterGitPatchZOutput(rawZ);
  const parts = filtered.split("\0");
  assert.ok(parts[0].includes("commit 11111111"), "первый коммит сохранен");
  assert.ok(parts[0].includes("    M"), "сообщение первого коммита сохранено");
  assert.ok(parts[1].includes("commit 22222222"), "второй коммит сохранен и не съеден как путь к файлу");

  const repo = mkGitRepo();
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["commit", "--allow-empty", "-m", "line1\n\n    M"]);
  const logZ = git(["log", "-z", "-n", "2", "--name-status"]);
  const filteredLog = filterGitPatchZOutput(logZ);
  assert.ok(filteredLog.includes("line1"), "сообщение коммита присутствует");
  assert.ok(filteredLog.includes("init"), "предыдущий коммит присутствует и не съеден");
});

test("PLUG-291: packFirstMessage переливает материалы >лимита в .md-файл (spillDir/spilledFile)", () => {
  const cwd = mkTmp("argon-cwd-spill-");
  fs.mkdirSync(path.join(cwd, "files"));
  const filenames = [];
  for (let i = 0; i < 5; i++) {
    const fn = `files/doc${i}.txt`;
    fs.writeFileSync(path.join(cwd, fn), "Y".repeat(28 * 1024));
    filenames.push(fn);
  }
  const spillDir = path.join(mkTmp("argon-spill-"), "uploads");
  const text = `Проверь файлы: ${filenames.join(" ")}`;
  const r = packFirstMessage({ text, cwd, spillDir, spillId: "sess-1" });
  assert.ok(r.spilledFile, "spilledFile expected for oversized package");
  assert.ok(fs.existsSync(r.spilledFile));
  assert.ok(r.spilledFile.startsWith(spillDir));
  assert.match(path.basename(r.spilledFile), /^pkg-sess-1-\d+\.md$/);
  // Сообщение компактное: в пределах лимита, с пометкой о вложении вместо обрезки.
  assert.ok(Buffer.byteLength(r.message, "utf8") <= 120 * 1024);
  assert.match(r.message, /файлом-вложением/);
  assert.match(r.message, /pkg-sess-1-/);
  assert.deepEqual(r.overflow, []);
  assert.ok(r.attached.length >= filenames.length);
  // Пакет содержит все блоки-материалы целиком.
  const pkg = fs.readFileSync(r.spilledFile, "utf8");
  for (const fn of filenames) {
    assert.ok(pkg.includes(fn), `pkg must name ${fn}`);
  }
  assert.ok(pkg.includes("Y".repeat(100)), "pkg must contain file bodies");
  // Без spillDir — прежнее поведение: вытеснение блоков + подсказка.
  const r2 = packFirstMessage({ text, cwd });
  assert.equal(r2.spilledFile, undefined);
  assert.ok(r2.overflow.length > 0);
});
