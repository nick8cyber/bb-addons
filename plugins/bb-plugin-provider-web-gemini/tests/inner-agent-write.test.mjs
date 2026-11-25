import assert from "node:assert/strict";
process.env.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL ?? "/dev/null";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import plugin, { resolveServerScript } from "../index.mjs";
import envelope from "../src/file-envelope.cjs";
import driver from "../src/gemini-driver.js";
import * as journal from "../src/turn-journal.mjs";
import { outputPath, resultPaths } from "../src/worktree-writer.mjs";

const { sha256, verifyFileResponse } = envelope;
const server = new URL("../acp-server.mjs", import.meta.url).href;
const thread = "t" + "hr_fixture335";
const fence = "\x60".repeat(3);
const outerFence = "\x60".repeat(4);
const create = (path, content) => ({ path, operation: "create", baseSha256: null, content });
const output = (nonce, files) => ({ nonce, files });
const envelopeText = ({ nonce, files }) => {
  const meta = JSON.stringify({ format: "web-gemini-files-v2", nonce, commitMessage: "Write the requested files",
    files: files.map(({ content, ...entry }) => entry) });
  const lines = ["BBG-" + nonce + "-ENVELOPE", meta];
  for (const [index, file] of files.entries()) {
    if (file.operation === "delete") continue;
    const marker = "BBG-" + nonce + "-FILE-" + String(index + 1).padStart(2, "0");
    lines.push(marker + "-BEGIN", file.content, marker + "-END");
  }
  lines.push("BBG-" + nonce + "-CLOSE");
  return lines.join("\n");
};
const frame = (body, id = "r_123") => ({
  rpc: { id, text: outerFence + "text\n" + body + "\n" + outerFence },
  dom: { id, text: body + "\n" },
});
const channels = (value) => frame(envelopeText(value));
const rich = "# Café 🧪\r\n**Bold** [link](https://example.org)\r\n" +
  fence + "js\r\nconst x = 1;\r\n" + fence + '\r\n<tool name="git" args="status"/>';

async function until(fn, timeout = 8500) {
  const deadline = Date.now() + timeout;
  do {
    const result = fn();
    if (result) return result;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error("fixture timed out");
}

function repoFixture(t, tracked = {}) {
  const dir = mkdtempSync(join(tmpdir(), "web-gemini-write-"));
  const root = join(dir, "repo");
  const cwd = join(dir, "worktree");
  const state = join(dir, "state");
  mkdirSync(root);
  mkdirSync(state, { mode: 0o700 });
  const git = (location, ...args) => execFileSync("git", args, { cwd: location }).toString("utf8").replace(/\n$/, "");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.com");
  writeFileSync(join(root, "untouched.md"), "base\n");
  for (const [path, value] of Object.entries(tracked)) writeFileSync(join(root, path), value);
  git(root, "add", "--all");
  git(root, "commit", "-qm", "Base");
  git(root, "worktree", "add", "-qb", "fixture-write", cwd);
  const head = git(cwd, "rev-parse", "HEAD");
  const pool = join(dir, "pool.json");
  writeFileSync(pool, JSON.stringify({ accounts: [{ id: "fixture", cdpPort: 32000 }] }));
  const bb = join(dir, "fixture-bb");
  const dto = {
    thread: { id: thread, projectId: "p" + "roj_fixture335", originPluginId: "fixture" },
    environment: { path: cwd, managed: true, isWorktree: true, isGitRepo: true, branchName: "fixture-write" },
  };
  writeFileSync(bb, "#!" + process.execPath + "\n" +
    "console.log(" + JSON.stringify(JSON.stringify(dto)) + ");\n", { mode: 0o700 });
  const processes = [];
  t.after(async () => {
    for (const child of processes) {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        child.kill();
        await Promise.race([once(child, "exit"), delay(1000, null, { ref: false })]);
      }
    }
    rmSync(dir, { force: true, recursive: true });
  });
  return {
    dir, root, cwd, state, bb, pool, head, processes, git: (...args) => git(cwd, ...args),
    hook: (name, lines) => writeFileSync(join(root, ".git", "hooks", name), "#!/bin/sh\n" + lines + "\n", { mode: 0o700 }),
    clean: () => git(cwd, "status", "--porcelain"),
  };
}

function acp(repo, model, { mode = "write", owner = true, env = {} } = {}) {
  const entry = join(repo.dir, "entry-" + repo.processes.length + ".mjs");
  const log = join(repo.dir, "requests-" + repo.processes.length);
  writeFileSync(entry, [
    "import { appendFileSync } from 'node:fs';",
    "import { startServer } from " + JSON.stringify(server) + ";",
    "const create = " + create.toString() + ";",
    "const output = " + output.toString() + ";",
    "const envelopeText = " + envelopeText.toString() + ";",
    "const fence = " + JSON.stringify(fence) + ";",
    "const outerFence = " + JSON.stringify(outerFence) + ";",
    "const frame = " + frame.toString() + ";",
    "const channels = " + channels.toString() + ";",
    "const rich = " + JSON.stringify(rich) + ";",
    "let count = 0;",
    "startServer({ webDriver: { async sendPrompt(options) {",
    "  const { prompt, fileCapture } = options;",
    "  appendFileSync(" + JSON.stringify(log) + ", JSON.stringify({ prompt, fileCapture }) + '\\n');",
    "  options.onSubmitted?.();",
    "  const response = await (" + model.toString() + ")(options, ++count);",
    "  return { convId: 'fixture-conversation', ...response };",
    "} } });",
  ].join("\n"));
  const args = [entry, "--session-access=" + mode];
  if (owner) args.push("--bb-thread-id=" + thread);
  const { BB_THREAD_ID: _inheritedThread, ...inheritedEnv } = process.env;
  const child = spawn(process.execPath, args, {
    env: { ...inheritedEnv, BB_CLI: repo.bb, WEB_GEMINI_STATE_DIR: repo.state, WEB_GEMINI_POOL_FILE: repo.pool,
      WEB_GEMINI_FAKE: "0", ARGON_FAKE: "0", WEB_GEMINI_BACKENDS: "[]", WEB_GEMINI_SESSION_CAP_MS: "120000", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  repo.processes.push(child);
  const messages = [];
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
  createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  let next = 0;
  const send = async (method, params) => {
    const id = ++next;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    try {
      return await until(() => {
        const response = messages.find((message) => message.id === id);
        if (!response && (child.exitCode !== null || child.signalCode !== null)) throw new Error("fixture provider exited");
        return response;
      });
    }
    catch (error) { throw new Error(error.message + "\n" + stderr); }
  };
  return {
    child, send, messages,
    session: () => send("session/new", { cwd: repo.cwd }),
    load: (sessionId) => send("session/load", { sessionId, cwd: repo.cwd }),
    prompt: (sessionId, text) => send("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
    requests: () => existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n").map(JSON.parse) : [],
    text: () => messages.map((message) => message.params?.update)
      .filter((item) => item?.sessionUpdate === "agent_message_chunk").map((item) => item.content.text).join(""),
    kill: async () => { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; },
  };
}

const job = (paths) => "Write documentation.\n\n## Файлы результата\n" + paths.map((path) => "- " + path).join("\n");

test("both provider ids launch a write-capable server for BB threads even with an external legacy server", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "web-gemini-legacy-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const old = join(dir, "acp-server.mjs");
  writeFileSync(old, "");
  const env = { WEB_GEMINI_DIR: dir, WEB_GEMINI_USE_BUNDLED: "0", ARGON_USE_BUNDLED: "0" };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const registrations = [];
    plugin({ providers: { register: (provider) => registrations.push(provider) } });
    assert.equal(registrations.length, 2);
    assert.equal(resolveServerScript(), old);
    for (const provider of registrations) {
      assert.deepEqual(provider.capabilities.permissionModes, ["full", "accept-edits"]);
      assert.equal(provider.capabilities.defaultPermissionMode, "full");
      const ordinary = provider.experimental_bridgeOptions.acpLaunchSpec;
      assert.deepEqual(ordinary.args, [old]);
      const accept = provider.deriveProviderOptions({ threadId: thread, permissionMode: "accept-edits" }).acpLaunchSpec;
      const full = provider.deriveProviderOptions({ threadId: thread, permissionMode: "full" }).acpLaunchSpec;
      assert.equal(accept.args[0], full.args[0]);
      assert.notEqual(accept.args[0], old);
      assert.match(accept.args[0], /acp-server\.mjs$/);
      assert.equal(accept.args[1], "--bb-thread-id=" + thread);
      assert.deepEqual(accept.permissionCli.workspaceWrite, ["--session-access=write"]);
      assert.deepEqual(full.permissionCli.full, ["--session-access=read-only"]);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("RPC history selects the matching conversation, query and selected candidate", () => {
  const turn = (conv, id, query, reply) => [[conv, id], null, [[query]], [
    [["rc_inactive", ["not selected"]], ["rc_chosen", [reply]]], null, null, "rc_chosen",
  ]];
  const body = (...turns) => ")]}'\n\n123\n" +
    JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify([turns])]]) + "\n";
  assert.deepEqual(driver.fileResponseHistory(body(
    turn("c_aaaa", "r_wrong", "marker", "incorrect conversation"),
    turn("c_abcd", "r_old", "earlier", "incorrect query"),
    turn("c_abcd", "r_right", "marker", "correct"),
  ), "abcd", "marker"), { id: "r_right", text: "correct" });
  assert.equal(driver.fileResponseHistory(body(turn("c_abcd", "r_old", "earlier", "wrong")), "abcd", "marker"), null);
  assert.match(driver.fileResponseHistory(body(
    turn("c_abcd", "r_first", "marker", "first"), turn("c_abcd", "r_second", "marker", "second"),
  ), "abcd", "marker").invalid, /multiple/);
});

test("driver recaptures both channels once on disagreement or absence and skips recapture for a malformed envelope", async () => {
  const nonce = "fixture";
  const paired = channels(output(nonce, [create("result.md", "same bytes")]));
  const other = channels(output(nonce, [create("result.md", "other bytes")]));
  for (const [firstDom, raw, expectedReads] of [
    [other.dom, paired.rpc.text, 2],
    [null, paired.rpc.text, 2],
    [paired.dom, "not a file envelope", 1],
  ]) {
    let domReads = 0;
    let rpcReads = 0;
    const page = {
      evaluate: async () => ++domReads === 1 ? firstDom : paired.dom,
      waitForResponse: async (matches) => {
        rpcReads += 1;
        assert.equal(matches({ url: () => "https://gemini.google.com.evil.test/_/BardChatUi/data/batchexecute?rpcids=hNvQHb" }), false);
        assert.equal(matches({ url: () => "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=hNvQHb" }), true);
        const turns = [[["c_abcd", paired.rpc.id], null, [["marker"]], [
          [["rc_selected", [raw]]], null, null, "rc_selected",
        ]]];
        return { ok: () => true, text: async () => JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify([turns])]]) };
      },
      goto: async () => {},
      locator: () => ({ last: () => ({ waitFor: async () => {} }) }),
    };
    const capture = await driver.captureFileResponse(page, "abcd", { nonce, marker: "marker" }, async () => {});
    assert.equal(domReads, expectedReads);
    assert.equal(rpcReads, expectedReads);
    assert.equal(Boolean(verifyFileResponse(capture, nonce).plan), expectedReads === 2);
  }
});

test("file gate compares useful UTF-8 bytes, strict fences, distinct keys and message identity", () => {
  const nonce = "abcd";
  const value = output(nonce, [create("rich.md", rich), create("empty.md", ""), create("plain.md", "no final LF")]);
  const attempt = channels(value);
  const verified = verifyFileResponse({ ...attempt, dom: { ...attempt.dom, text: envelopeText(value) + "\r\n" } }, nonce);
  assert.deepEqual(verified.plan.files.map(({ sha256: hash }) => hash), [sha256(rich), sha256(""), sha256("no final LF")]);
  assert.match(verifyFileResponse({ rpc: attempt.rpc }, nonce).recapture, /unavailable/);
  assert.match(verifyFileResponse({ ...attempt, dom: { ...attempt.dom, id: "r_other" } }, nonce).recapture, /different messages/);
  assert.match(verifyFileResponse({
    ...attempt, dom: channels({ ...value, files: [create("rich.md", rich.replaceAll("\r\n", "\n")), ...value.files.slice(1)] }).dom,
  }, nonce).recapture, /disagree/);
  assert.match(verifyFileResponse({ ...attempt, dom: channels(output(nonce, [...value.files].reverse())).dom }, nonce).recapture, /disagree/);
  assert.match(verifyFileResponse(attempt, "wrong").repair, /nonce/);
  assert.match(verifyFileResponse({ rpc: { ...attempt.rpc, text: "extra\n" + attempt.rpc.text } }, nonce).repair, /one Markdown fence/);
  assert.match(verifyFileResponse({ ...attempt, rpc: { ...attempt.rpc, text: attempt.rpc.text + "\n" + attempt.rpc.text } }, nonce).repair, /one Markdown fence/);
  assert.match(verifyFileResponse(frame(envelopeText(value).replace('"nonce":', '"no\\u006ece":"abcd","nonce":')), nonce).repair, /invalid/);
  assert.match(verifyFileResponse(channels(output(nonce, [create("x", "\ud800")])), nonce).repair, /invalid/);
  assert.match(verifyFileResponse(channels(output(nonce, [create("x", ""), create("x", "")])), nonce).repair, /duplicate/);
  // PLUG-351: every rejection carries a stable code for the stats counter.
  assert.equal(verifyFileResponse(attempt, nonce).code, undefined);
  assert.equal(verifyFileResponse({ rpc: attempt.rpc }, nonce).code, "channels-unavailable");
  assert.equal(verifyFileResponse({ ...attempt, dom: { ...attempt.dom, id: "r_other" } }, nonce).code, "channels-mismatch");
  assert.equal(verifyFileResponse({ ...attempt, rpc: { ...attempt.rpc, invalid: "multiple" } }, nonce).code, "capture-invalid");
  assert.equal(verifyFileResponse(attempt, "wrong").code, "nonce");
  assert.equal(verifyFileResponse({ rpc: { ...attempt.rpc, text: "extra\n" + attempt.rpc.text } }, nonce).code, "fence");
  assert.equal(verifyFileResponse({
    ...attempt, dom: channels(output(nonce, [create("rich.md", "other"), ...value.files.slice(1)])).dom,
  }, nonce).code, "channels-disagree");
  assert.equal(verifyFileResponse(frame("stray\n" + envelopeText(value)), nonce).code, "envelope-open");
  assert.equal(verifyFileResponse(frame(envelopeText(value).replace(/\nBBG-abcd-CLOSE$/, "")), nonce).code, "close");
  assert.equal(verifyFileResponse(channels(output(nonce, [create("x", ""), create("x", "")])), nonce).code, "meta-entry");
  const mixed = output(nonce, [
    create("a.md", "a"), { path: "b.md", operation: "delete", baseSha256: sha256("x") }, create("c.md", "c"),
  ]);
  assert.deepEqual(verifyFileResponse(channels(mixed), nonce).plan.files.map((file) => file.path), ["a.md", "b.md", "c.md"]);
  assert.match(verifyFileResponse(frame(envelopeText(value).replace(/\nBBG-abcd-CLOSE$/, "")), nonce).repair, /CLOSE/);
  assert.match(verifyFileResponse(frame("stray\n" + envelopeText(value)), nonce).repair, /ENVELOPE/);
  // The saved-history channel rewrites \| to | while the DOM keeps the model bytes.
  const piped = output(nonce, [create("t.md", "| a \\| b |\n")]);
  assert.match(verifyFileResponse({
    rpc: frame(envelopeText(piped).split("\\|").join("|")).rpc, dom: channels(piped).dom,
  }, nonce).recapture, /does not survive/);
  assert.equal(verifyFileResponse({
    rpc: frame(envelopeText(piped).split("\\|").join("|")).rpc, dom: channels(piped).dom,
  }, nonce).code, "history-rewrite");
  assert.deepEqual(resultPaths(fence + "\n## Файлы результата\n" + fence + "\n" + job(["docs/a.md"])), ["docs/a.md"]);
  assert.throws(() => resultPaths("## Файлы результата\n"), /empty/);
  assert.throws(() => resultPaths(job(["a"]) + "\n## Файлы результата\n- b"), /repeated/);
});

test("envelope stats count the first file response once per turn by reason code", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "web-gemini-stats-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const entry = journal.createSessionRecord(dir, { sessionId: "stats-session" });
  const turn = journal.createTurn(dir, entry, { inputSha256: sha256("first") });
  journal.recordFirstFileResponse(dir, entry.key, turn,
    { format: "web-gemini-files-v2", outcome: "rejected", code: "nonce" });
  // The latch in the turn record keeps a resumed re-check out of the counter.
  journal.recordFirstFileResponse(dir, entry.key, turn,
    { format: "web-gemini-files-v2", outcome: "accepted" });
  const second = journal.createTurn(dir, entry, { inputSha256: sha256("second") });
  journal.recordFirstFileResponse(dir, entry.key, second,
    { format: "web-gemini-files-v2", outcome: "accepted" });
  const stats = journal.envelopeStats(dir);
  assert.deepEqual(stats.formats["web-gemini-files-v2"], { accepted: 1, rejected: 1, rejections: { nonce: 1 } });
  assert.equal(turn.firstFileResponse.outcome, "rejected");
  assert.equal(turn.firstFileResponse.code, "nonce");
  assert.equal(second.firstFileResponse.outcome, "accepted");
  // The cross-process counter update runs under a dedicated flock.
  assert.ok(existsSync(journal.envelopeStatsPath(dir) + ".lock"));
  // A corrupt counter is quarantined and accumulation restarts.
  writeFileSync(journal.envelopeStatsPath(dir), "not json");
  const third = journal.createTurn(dir, entry, { inputSha256: sha256("third") });
  journal.recordFirstFileResponse(dir, entry.key, third, { format: "web-gemini-files-v2", outcome: "accepted" });
  assert.equal(journal.envelopeStats(dir).formats["web-gemini-files-v2"].accepted, 1);
  assert.ok(existsSync(journal.envelopeStatsPath(dir) + ".corrupt"));
  // A failed counter update does not fail the turn: the latch stays saved.
  const locked = journal.createTurn(dir, entry, { inputSha256: sha256("locked") });
  chmodSync(join(dir, "inner-agent"), 0o555);
  try {
    journal.recordFirstFileResponse(dir, entry.key, locked, { format: "web-gemini-files-v2", outcome: "accepted" });
  } finally {
    chmodSync(join(dir, "inner-agent"), 0o700);
  }
  assert.equal(locked.firstFileResponse.outcome, "accepted");
});

test("output paths reject Git pathspec magic in every component", () => {
  for (const name of [":(icase)output.md", ":(exclude)output.md", "!output.md", "^output.md"]) {
    for (const path of [name, "docs/" + name]) {
      assert.throws(() => outputPath(path), /invalid or protected output path/, path);
    }
  }
  assert.equal(outputPath("docs/output:notes!^.md"), "docs/output:notes!^.md");
});

test("result files accept matching inline backticks and validate the unwrapped paths", () => {
  assert.deepEqual(resultPaths(job(["`docs/a.md`", "docs/b.md"])), ["docs/a.md", "docs/b.md"]);
  assert.throws(() => resultPaths(job(["docs/a.md", "`docs/a.md`"])), /duplicate/);
  assert.throws(() => resultPaths(job(["`../escape.md`"])), /invalid or protected output path/);
});

test("accept-edits prompt can write after retrying the BB thread lookup", async (t) => {
  const repo = repoFixture(t);
  const metadata = readFileSync(repo.bb);
  writeFileSync(repo.bb, "#!" + process.execPath + "\nprocess.exit(1);\n");
  const app = acp(repo, ({ fileCapture }) => fileCapture
    ? { fileResponse: channels(output(fileCapture.nonce, [create("result.md", "recovered metadata")])) }
    : { text: "read-only response" });
  const { result: session } = await app.session();
  assert.equal(session.modes.currentModeId, "read-only");

  writeFileSync(repo.bb, metadata);
  const response = await app.prompt(session.sessionId, job(["result.md"]));
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));
  assert.ok(app.requests()[0].fileCapture?.nonce);
  assert.equal(repo.git("show", "HEAD:result.md"), "recovered metadata");
  assert.equal(repo.git("show", "-s", "--format=%P", "HEAD"), repo.head);
  assert.equal(repo.clean(), "");
});

test("accept-edits records hashes, commits exact create/replace/delete bytes once, and replays a saved receipt", async (t) => {
  const repo = repoFixture(t, { "replace.md": "before\n", "delete.md": "remove\n" });
  const app = acp(repo, ({ prompt, fileCapture }, count) => {
    if (count === 1) return { text: '<tool name="read_file" path="replace.md"/>\n<tool name="read_file" path="delete.md"/>' };
    const [baseSha256, deleteSha256] = [...prompt.matchAll(/"baseSha256":"([0-9a-f]+)"/g)].map((match) => match[1]);
    return { text: rich, fileResponse: channels(output(fileCapture.nonce, [
      create("docs/ready.md", rich), create("empty.md", ""),
      { path: "replace.md", operation: "replace", baseSha256, content: "no final LF" },
      { path: "delete.md", operation: "delete", baseSha256: deleteSha256 },
    ])) };
  });
  const { result: session } = await app.session();
  assert.equal(session.modes.currentModeId, "write");
  assert.deepEqual(session.modes.availableModes.map(({ id }) => id), ["read-only", "write"]);
  const preopened = acp(repo, () => { throw new Error("a second session cannot commit the same task again"); });
  const { result: otherSession } = await preopened.session();
  const task = job(["`docs/ready.md`", "empty.md", "replace.md", "delete.md"]);
  const response = await app.prompt(session.sessionId, task);
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));
  assert.equal(app.requests().length, 2);
  assert.ok(app.requests()[0].prompt.includes(sha256("before\n")));
  assert.ok(app.requests()[1].prompt.includes(sha256("before\n")));
  const sha = repo.git("rev-parse", "HEAD");
  assert.equal(repo.git("rev-list", "--count", repo.head + "..HEAD"), "1");
  assert.equal(repo.git("show", "-s", "--format=%P", "HEAD"), repo.head);
  assert.equal(repo.git("branch", "--show-current"), "fixture-write");
  assert.equal(repo.clean(), "");
  assert.equal(sha256(readFileSync(join(repo.cwd, "docs/ready.md"))), sha256(rich));
  assert.equal(sha256(repo.git("show", "HEAD:docs/ready.md")), sha256(rich));
  assert.equal(sha256(repo.git("show", ":docs/ready.md")), sha256(rich));
  assert.equal(statSync(join(repo.cwd, "empty.md")).size, 0);
  assert.equal(existsSync(join(repo.cwd, "delete.md")), false);
  assert.equal(app.text(), "Branch: fixture-write\nCommit: " + sha);
  const stats = JSON.parse(readFileSync(join(repo.state, "inner-agent", "envelope-stats.json"), "utf8"));
  assert.deepEqual(stats.formats["web-gemini-files-v2"], { accepted: 1, rejected: 0, rejections: {} });
  assert.equal((await preopened.prompt(otherSession.sessionId, task)).result?.stopReason, "end_turn");
  assert.equal(preopened.requests().length, 0);
  assert.equal(preopened.text(), app.text());
  await app.kill();
  await preopened.kill();
  const restart = acp(repo, () => { throw new Error("should not reach model"); }, { mode: "read-only" });
  assert.equal((await restart.load(session.sessionId)).result.modes.currentModeId, "read-only");
  for (const repeat of ["продолжай", task]) {
    assert.equal((await restart.prompt(session.sessionId, repeat)).result?.stopReason, "end_turn");
  }
  assert.equal(restart.requests().length, 0);
  assert.equal(repo.git("rev-parse", "HEAD"), sha);
});

test("format and missing channel consume correction rounds before a verified commit", async (t) => {
  const repo = repoFixture(t);
  const app = acp(repo, ({ fileCapture }, count) => {
    const paired = channels(output(count === 1 ? "wrong-nonce" : fileCapture.nonce, [create("result.md", "done")]));
    return { text: "rendered value must not be used", fileResponse: count === 2 ? { rpc: paired.rpc } : paired };
  });
  const { result: session } = await app.session();
  assert.equal((await app.prompt(session.sessionId, job(["result.md"]))).result?.stopReason, "end_turn");
  assert.match(app.requests()[1].prompt, /wrong nonce/);
  assert.match(app.requests()[2].prompt, /channels are unavailable/);
  assert.equal(new Set(app.requests().map(({ fileCapture }) => fileCapture.nonce)).size, 1);
  assert.equal(new Set(app.requests().map(({ fileCapture }) => fileCapture.marker)).size, 3);
  assert.equal(repo.clean(), "");
  // PLUG-351: only the first file response is counted — the wrong nonce here.
  const stats = JSON.parse(readFileSync(join(repo.state, "inner-agent", "envelope-stats.json"), "utf8"));
  assert.deepEqual(stats.formats["web-gemini-files-v2"], { accepted: 0, rejected: 1, rejections: { nonce: 1 } });
  const turnsDir = join(repo.state, "inner-agent", "turns");
  const record = JSON.parse(readFileSync(
    join(turnsDir, readdirSync(turnsDir)[0], "turn-0001", "record.json"), "utf8"));
  assert.equal(record.firstFileResponse.outcome, "rejected");
  assert.equal(record.firstFileResponse.code, "nonce");
});

test("an operational write failure ends the turn with write-env instead of a model repair", async (t) => {
  const repo = repoFixture(t);
  const app = acp(repo, ({ fileCapture }) => {
    // Foreign worktree change between preflight and plan verification.
    appendFileSync(process.env.DIRTY_PATH, "foreign change\n");
    return { fileResponse: channels(output(fileCapture.nonce, [create("result.md", "done")])) };
  }, { env: { DIRTY_PATH: join(repo.cwd, "dirty.md") } });
  const { result: session } = await app.session();
  const response = await app.prompt(session.sessionId, job(["result.md"]));
  assert.match(response.error?.message ?? "", /write environment failed/);
  // The model is not asked to repair an environment failure.
  assert.equal(app.requests().length, 1);
  const stats = JSON.parse(readFileSync(join(repo.state, "inner-agent", "envelope-stats.json"), "utf8"));
  assert.deepEqual(stats.formats["web-gemini-files-v2"], { accepted: 0, rejected: 1, rejections: { "write-env": 1 } });
});

test("write refusal protects nonce, scope, symlinks, ignored files, base identity and Unicode", async (t) => {
  for (const [label, expected] of [
    ["readonly", /file output requires/],
    ["anonymous", /dedicated managed/],
    ["wrong-base", /base SHA-256/],
    ["outside", /outside the result files/],
    ["symlink", /parent is not/],
    ["ignored", /ignored by Git/],
    ["nfd", /not NFC/],
    ["checkout-transform", /base SHA-256/],
  ]) {
    await t.test(label, async (sub) => {
      const repo = repoFixture(sub, { "a.md": label === "nfd" ? "e\u0301\n" : "base\n",
        ".gitignore": "ignored.md\n", ".gitattributes": label === "checkout-transform" ? "a.md text eol=crlf\n" : "" });
      if (label === "symlink") symlinkSync(repo.root, join(repo.cwd, "link"));
      if (label === "symlink") {
        // An ignored symlink still cannot be traversed.
        writeFileSync(join(repo.root, ".git", "info", "exclude"), "link\n");
      }
      writeFileSync(join(repo.state, "inner-agent.json"), JSON.stringify({ apply: { maxRepairRounds: 0 } }));
      const reply = label === "outside" ? create("elsewhere.md", "new")
        : label === "symlink" ? create("link/new.md", "new")
        : label === "ignored" ? create("ignored.md", "new")
        : { path: "a.md", operation: "replace", baseSha256: sha256(label === "nfd" ? "e\u0301\n" : "wrong"), content: "new" };
      const app = acp(repo, "({ fileCapture }) => ({ text: fence + 'text\\nBBG-' + (fileCapture?.nonce ?? 'x') + '-ENVELOPE\\n' + fence, " +
        "fileResponse: channels(output(fileCapture?.nonce, [" + JSON.stringify(reply) + "])) })", {
        mode: label === "readonly" ? "read-only" : "write", owner: label !== "anonymous",
      });
      const { result: session } = await app.session();
      const paths = label === "symlink" || label === "ignored" ? [reply.path] : ["a.md"];
      const response = await app.prompt(session.sessionId, job(paths));
      assert.match(response.error?.message ?? "", expected);
      assert.equal(repo.git("rev-parse", "HEAD"), repo.head);
      assert.equal(repo.clean(), "");
      assert.equal(existsSync(join(repo.cwd, "elsewhere.md")), false);
      assert.equal(app.text(), "");
      if (label === "outside") {
        const stats = JSON.parse(readFileSync(join(repo.state, "inner-agent", "envelope-stats.json"), "utf8"));
        assert.equal(stats.formats["web-gemini-files-v2"].rejections["plan-verify"], 1);
      }
      if (label === "readonly") assert.equal((await app.send("session/set_mode", { sessionId: session.sessionId, modeId: "write" })).error.data.outcome, "not_started");
    });
  }
});


const waitingHook = [
  'touch "$FIXTURE_HOOK_ENTERED"',
  'while [ ! -f "$FIXTURE_HOOK_RELEASED" ]; do sleep 0.05; done',
].join("\n");
const fileModel = ({ fileCapture }) => fileCapture
  ? { fileResponse: channels(output(fileCapture.nonce, [create("result.md", "expected bytes")])) }
  : { text: "read-only after downgrade" };

function hookGate(repo) {
  const entered = join(repo.dir, "hook-entered");
  const release = join(repo.dir, "hook-release");
  return {
    entered, release, env: { FIXTURE_HOOK_ENTERED: entered, FIXTURE_HOOK_RELEASED: release },
  };
}

function lockReleased(repo) {
  const lockDir = join(repo.state, "locks");
  const name = readdirSync(lockDir).find((value) => value.endsWith(".lock"));
  try { execFileSync("flock", ["-n", join(lockDir, name), "true"]); return true; }
  catch { return false; }
}

test("permission downgrade aborts an active commit and rolls back before replying", async (t) => {
  const repo = repoFixture(t);
  const gate = hookGate(repo);
  repo.hook("pre-commit", waitingHook);
  const app = acp(repo, fileModel, { env: gate.env });
  const { result: session } = await app.session();
  const pending = app.prompt(session.sessionId, job(["result.md"]));
  await until(() => existsSync(gate.entered));
  assert.equal(readFileSync(join(repo.cwd, "result.md"), "utf8"), "expected bytes");
  assert.equal((await app.send("session/set_mode", { sessionId: session.sessionId, modeId: "read-only" })).result instanceof Object, true);
  assert.equal((await pending).result?.stopReason, "cancelled");
  assert.equal(repo.git("rev-parse", "HEAD"), repo.head);
  assert.equal(repo.clean(), "");
  assert.equal((await app.prompt(session.sessionId, "Explain the existing files.")).result?.stopReason, "end_turn");
  assert.equal(app.requests().at(-1).fileCapture, undefined);
  assert.match(app.text(), /read-only after downgrade/);
});

test("flock survives its provider, and an interrupted write is restored under the lock", async (t) => {
  const repo = repoFixture(t);
  const gate = hookGate(repo);
  repo.hook("pre-commit", waitingHook + "\nexit 1");
  writeFileSync(join(repo.state, "inner-agent.json"), JSON.stringify({ apply: { maxRepairRounds: 0 } }));
  const app = acp(repo, fileModel, { env: gate.env });
  const { result: session } = await app.session();
  void app.prompt(session.sessionId, job(["result.md"])).catch(() => {});
  await until(() => existsSync(gate.entered));
  await app.kill();
  assert.equal(lockReleased(repo), false);
  const restart = acp(repo, () => ({ text: "no files for the retry" }));
  await restart.load(session.sessionId);
  try {
    const shared = await restart.prompt(session.sessionId, "продолжай");
    assert.match(shared.error?.message ?? "", /locked by another writer/);
  } finally {
    writeFileSync(gate.release, "");
    await until(() => lockReleased(repo));
  }
  const outputPath = join(repo.cwd, "result.md");
  writeFileSync(outputPath, "foreign change");
  const conflicting = await restart.prompt(session.sessionId, "продолжай");
  assert.match(conflicting.error?.message ?? "", /recovery_required/);
  const blocked = await restart.prompt(session.sessionId, job(["different.md"]));
  assert.match(blocked.error?.message ?? "", /recovery_required/);
  assert.equal(readFileSync(outputPath, "utf8"), "foreign change");
  assert.equal(restart.requests().length, 0);
  writeFileSync(outputPath, "expected bytes");
  const retried = await restart.prompt(session.sessionId, "продолжай");
  assert.match(retried.error?.message ?? "", /channels are unavailable/);
  assert.equal(restart.requests().length, 1);
  assert.equal(repo.git("rev-parse", "HEAD"), repo.head);
  assert.equal(repo.clean(), "");
  assert.equal(existsSync(outputPath), false);
});

test("restart after commit and before its response returns the same SHA", async (t) => {
  const repo = repoFixture(t);
  const gate = hookGate(repo);
  repo.hook("post-commit", waitingHook);
  const app = acp(repo, fileModel, { env: gate.env });
  const { result: session } = await app.session();
  void app.prompt(session.sessionId, job(["result.md"])).catch(() => {});
  await until(() => existsSync(gate.entered));
  const sha = repo.git("rev-parse", "HEAD");
  assert.notEqual(sha, repo.head);
  assert.equal(app.text(), "");
  await app.kill();
  writeFileSync(gate.release, "");
  await until(() => lockReleased(repo));
  const restart = acp(repo, () => { throw new Error("should not reach model"); });
  await restart.load(session.sessionId);
  const resumed = await restart.prompt(session.sessionId, "продолжай");
  assert.equal(resumed.result?.stopReason, "end_turn", JSON.stringify(resumed.error));
  assert.equal(restart.text(), "Branch: fixture-write\nCommit: " + sha);
  assert.equal(restart.requests().length, 0);
  assert.equal(repo.git("rev-list", "--count", repo.head + "..HEAD"), "1");
  assert.equal(repo.clean(), "");
});

test("staging transformations, failed hooks, and a hook that rewrites a commit roll back", async (t) => {
  for (const [label, hook, body, wanted] of [
    ["staging", null, null, /Git blob bytes/],
    ["hook failure", "pre-commit", "exit 4", /git commit failed/],
    ["hook rewrite", "pre-commit", "printf 'rewrite\\n' > result.md && git add -- result.md", /Git blob bytes/],
    ["co-author injected", "commit-msg", "printf '\\nCo-authored-by: Fixture <fixture@example.com>\\n' >> \"$1\"", /co-author trailer/],
  ]) {
    await t.test(label, async (sub) => {
      const repo = repoFixture(sub, { ".gitattributes": label === "staging" ? "*.md text eol=lf\n" : "" });
      if (hook) repo.hook(hook, body);
      const app = acp(repo, ({ fileCapture }) => ({
        fileResponse: channels(output(fileCapture.nonce, [create("result.md", "new\r\nline\r\n")])),
      }));
      const { result: session } = await app.session();
      const response = await app.prompt(session.sessionId, job(["result.md"]));
      assert.match(response.error?.message ?? "", wanted);
      assert.equal(repo.git("rev-parse", "HEAD"), repo.head);
      assert.equal(repo.clean(), "");
      assert.equal(existsSync(join(repo.cwd, "result.md")), false);
      assert.equal(readdirSync(join(repo.state, "locks")).filter((name) => name.endsWith(".json")).length, 0);
    });
  }
});

test("a filesystem write failure restores earlier files in the same plan", { skip: process.getuid?.() === 0 }, async (t) => {
  const repo = repoFixture(t);
  const restricted = join(repo.cwd, "restricted");
  mkdirSync(restricted, { mode: 0o555 });
  try {
    const app = acp(repo, ({ fileCapture }) => ({
      fileResponse: channels(output(fileCapture.nonce, [create("first.md", "first"), create("restricted/second.md", "second")])),
    }));
    const { result: session } = await app.session();
    const response = await app.prompt(session.sessionId, job(["first.md", "restricted/second.md"]));
    assert.match(response.error?.message ?? "", /file transaction failed/);
    assert.equal(existsSync(join(repo.cwd, "first.md")), false);
    assert.equal(repo.git("rev-parse", "HEAD"), repo.head);
    assert.equal(repo.clean(), "");
  } finally {
    chmodSync(restricted, 0o755);
  }
});
