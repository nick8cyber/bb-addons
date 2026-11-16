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

test("3. git: опции записи (--output, --exec) отклоняются", () => {
  const repo = mkGitRepo();
  const r = executeTool(
    { name: "git", args: { args: "diff --output=/tmp/x HEAD" }, attrs: [["args", "diff --output=/tmp/x HEAD"]] },
    { cwd: repo },
  );
  assert.equal(r.ok, false);
  assert.match(r.output, /git option not allowed/);
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

test("7. packFirstMessage: переполнение — подсказка «Можно запросить инструментом:»", () => {
  const cwd = mkTmp("argon-cwd-");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "alpha.md"), "ALPHA-BODY");
  const text = `Проверь src/alpha.md, тред ${THREAD_ID} и задачу PLUG-129.`;
  const r = withBbStub(() => packFirstMessage({ text, cwd, maxBytes: 900 }));
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
