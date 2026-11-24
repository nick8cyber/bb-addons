import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import * as journal from "../src/turn-journal.mjs";

const server = new URL("../acp-server.mjs", import.meta.url).href;
const threadId = "t" + "hr_" + "fixture456";
const projectId = "p" + "roj_" + "fixture456";
const key = "EX" + "AMPLE-" + "77";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const blockText = (text) => ({ type: "text", text });
const FINAL = "Report body\n{\"verdict\":\"OK\",\"blockers\":0}";

function setup(t) {
  const tmp = mkdtempSync(join(tmpdir(), "web-gemini-resume-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const write = (file, text) => {
    const dest = join(repo, file);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  write("docs/notes.txt", "base value\n");
  git("add", ".");
  git("commit", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/base", base);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/base");

  git("switch", "-c", "review");
  write("docs/notes.txt", "review value\nZX12-marker\n");
  write("docs/review-only.txt", "review value match\n");
  git("add", ".");
  git("commit", "-m", "Review");
  const sha = git("rev-parse", "HEAD");

  git("switch", "main");
  write("docs/notes.txt", "different HEAD\n");
  git("add", ".");
  git("commit", "-m", "Independent HEAD");
  const head = git("rev-parse", "HEAD");
  return { tmp, repo, git, write, sha, base, head };
}

function task(text, { ref } = {}) {
  const review = ref ? "## Additional instructions\n\nResult under review: commit " + ref : "";
  return ["# " + key + " · Resume fixture", "## Description", text, "## Attachments", "None.", review].filter(Boolean).join("\n\n");
}

async function waitFor(predicate, seconds = 25) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error("fixture timed out");
}

function rpcProcess(t, args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  const messages = [];
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await Promise.race([once(child, "exit"), delay(1000, null, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
  let id = 0;
  function notify(method, params, id) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params, ...(id ? { id } : {}) }) + "\n");
  }
  function send(method, params) {
    const current = ++id;
    notify(method, params, current);
    return waitFor(() => {
      if (child.exitCode !== null) throw new Error("fixture exited: " + stderr);
      return messages.find((message) => message.id === current);
    });
  }
  return { child, messages, send, notify };
}

// Фикстура сервера: фальшивый bb CLI + фальшивый драйвер, записывающий запросы.
// options.stateDir — общий журнальный каталог для «рестарта» процесса.
function fixture(t, repo, model, options = {}) {
  const dir = mkdtempSync(join(repo.tmp, "instance-"));
  const cli = join(dir, "bb-fixture.mjs");
  const state = options.stateDir ?? join(dir, "state");
  const requests = join(dir, "requests.jsonl");
  const pool = join(dir, "pool.json");
  mkdirSync(state, { recursive: true });
  const defaultBackend = { id: "web-fixture", cdp: 19223, profileDir: dir, tier: "pro" };
  writeFileSync(pool, JSON.stringify({ accounts: options.backends ?? [defaultBackend] }));
  if (options.settings) writeFileSync(join(state, "inner-agent.json"), JSON.stringify(options.settings));
  const quoted = JSON.stringify;
  writeFileSync(cli, "#!/usr/bin/env node\n" + String.raw`
const threadId = ${quoted(threadId)};
const projectId = ${quoted(projectId)};
const [area, action, arg, ...extra] = process.argv.slice(2);
if (area === "thread" && action === "show" && arg === threadId && extra[0] === "--json") {
  console.log(JSON.stringify({
    thread: { id: threadId, projectId, originPluginId: "fixture-orchestrator" },
    environment: { path: ${quoted(options.mismatchedCwd ?? repo.repo)}, mergeBaseBranch: "base", baseBranch: "wrong" },
  }));
} else process.exitCode = 2;
`);
  chmodSync(cli, 0o700);
  const entry = join(dir, "server-fixture.mjs");
  writeFileSync(entry, `
import { appendFileSync, readFileSync } from "node:fs";
import { startServer } from ${quoted(server)};
let count = 0;
startServer({ webDriver: { async sendPrompt(options) {
  const files = (options.files ?? []).map((path) => ({ path, text: readFileSync(path, "utf8"), data: readFileSync(path).toString("base64") }));
  const request = { prompt: options.prompt, files, convId: options.convId, strict: options.requireFullDelivery, verify: options.verifyConversation,
    model: options.model, thinking: options.thinking, account: options.accountId, count: ++count };
  appendFileSync(${quoted(requests)}, JSON.stringify(request) + "\\n");
  options.onSubmitted?.();
  const response = await (${model})(request, options, ${quoted({ cwd: repo.repo, head: repo.head })});
  return { convId: options.convId || "fixture-conversation-" + count, ...response };
} } });
`);
  const args = [entry, "--session-access=read-only"];
  if (options.owner !== false) args.push("--bb-thread-id=" + (options.owner ?? threadId));
  const env = {
    BB_CLI: cli, WEB_GEMINI_FAKE: "0", ARGON_FAKE: "0",
    WEB_GEMINI_STATE_DIR: state, WEB_GEMINI_POOL_FILE: pool, WEB_GEMINI_BACKENDS: "[]",
    WEB_GEMINI_SESSION_CAP_MS: "120000",
    ...options.env,
  };
  const launch = { displayName: "Fixture", command: process.execPath, args, env };
  const bridgeOptions = {
    permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null,
    providerOptions: { acpDialect: "generic", acpLaunchSpec: launch },
  };
  let rpc;
  if (options.bridge) {
    const sdk = dirname(fileURLToPath(import.meta.resolve("@get-bb/plugin-sdk/provider-bridge/acp")));
    const worker = join(sdk, "provider-bridge-worker-entry.mjs");
    const host = fileURLToPath(new URL("../host.mjs", import.meta.url));
    rpc = rpcProcess(t, [worker, host, "provider-fixture", dir], process.env);
  } else {
    const { BB_THREAD_ID: _inheritedThread, ...inheritedEnv } = process.env;
    rpc = rpcProcess(t, args, { ...inheritedEnv, ...env });
  }
  const { child, messages, send, notify } = rpc;
  return {
    child, messages, send, notify, state, bridgeOptions,
    kill: () => child.kill("SIGKILL"),
    requests: () => existsSync(requests) ? readFileSync(requests, "utf8").trimEnd().split("\n").map(JSON.parse) : [],
    newSession: async (cwd = repo.repo) => {
      const response = await send("session/new", { cwd });
      return response.result.sessionId;
    },
    loadSession: (sessionId, cwd = repo.repo) => send("session/load", { sessionId, cwd }),
    prompt: (sessionId, text, extra = []) => send("session/prompt", { sessionId, prompt: [...extra, blockText(text)] }),
    // Запрос с id, но без ожидания ответа — для хода, который оборвём SIGKILL.
    notifyPrompt: (sessionId, text, extra = []) => notify("session/prompt", { sessionId, prompt: [...extra, blockText(text)] }, 999),
  };
}

const records = (state) => journal.listSessionRecords(state);
const turns = (state, key) => journal.listTurns(state, key);
const journalTurnsDir = (state, key, turnNo) => journal.turnDir(state, key, turnNo);

test("fresh task turn writes session record, package, exchanges and outcome into the provider journal", async (t) => {
  const repo = setup(t);
  const app = fixture(t, repo, `(request) => ({ text: ${JSON.stringify(FINAL)} })`);
  const sessionId = await app.newSession();
  const response = await app.prompt(sessionId, task("Review the change", { ref: "review" }));
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));

  const recs = records(app.state);
  assert.equal(recs.length, 1);
  const rec = recs[0].record;
  assert.equal(rec.threadId, threadId);
  assert.equal(rec.projectId, projectId);
  assert.equal(rec.accessCeiling, "read-only");
  assert.ok(rec.convId, "session record keeps the conversation id");
  assert.ok(rec.backendId, "session record keeps the backend id");
  assert.equal(rec.fingerprint.cwd, repo.repo);
  assert.ok(rec.fingerprint.gitDir);

  const [turn] = turns(app.state, recs[0].key);
  assert.equal(turn.record.turnNo, 1);
  assert.equal(turn.record.outcome, "passed");
  assert.equal(turn.record.delivered, true);
  assert.ok(turn.record.packageSha256);
  assert.ok(turn.record.convId);
  assert.equal(turn.record.pin.sha, repo.sha);
  assert.equal(turn.record.expected, "verdict");
  assert.deepEqual(turn.record.profile, { model: "neon", thinking: "medium", account: "auto" });
  assert.ok(turn.record.deadlineAt > turn.record.createdAt);
  const dir = journalTurnsDir(app.state, recs[0].key, 1);
  const pkg = readFileSync(join(dir, "package.md"), "utf8");
  assert.match(pkg, /=== Опись \/ Manifest ===/);
  assert.equal(readFileSync(join(dir, "answer.txt"), "utf8"), FINAL);
  const exchanges = readFileSync(join(dir, "exchanges.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(exchanges.some((entry) => entry.kind === "reply"));
  // Журнал живёт в state-каталоге провайдера, не в рабочей копии.
  assert.ok(!existsSync(join(repo.repo, "inner-agent")));
});

test("session/load restores an unfinished turn and continues it in the same conversation", async (t) => {
  const repo = setup(t);
  const first = fixture(t, repo, (request) => request.count === 1
    ? { text: '<tool name="read_file" path="docs/notes.txt"/>' }
    : new Promise(() => {}));
  const sessionId = await first.newSession();
  await first.send("session/set_model", { sessionId, modelId: "pro" });
  await first.send("session/set_config_option", { sessionId, configId: "thinking", value: "high" });
  await first.send("session/set_config_option", { sessionId, configId: "account", value: "web-fixture" });
  // Вторая отправка висит навсегда — имитация аварийного завершения mid-turn.
  const text = task("Review the change", { ref: "review" });
  first.notifyPrompt(sessionId, text);
  await waitFor(() => first.requests().length >= 2);
  first.kill();
  await waitFor(() => first.child.exitCode !== null || first.child.signalCode !== null);

  const recs = records(first.state);
  const turn = turns(first.state, recs[0].key)[0].record;
  assert.equal(turn.outcome, null);
  assert.equal(turn.delivered, true);
  assert.equal(turn.convId, "fixture-conversation-1");

  const app = fixture(t, repo, `() => ({ text: ${JSON.stringify(FINAL)} })`, { stateDir: first.state });
  const loaded = await app.loadSession(sessionId);
  assert.ok(loaded.result, JSON.stringify(loaded.error));
  assert.equal(loaded.result.sessionId, sessionId);
  await app.send("session/set_model", { sessionId, modelId: "neon" });
  await app.send("session/set_config_option", { sessionId, configId: "thinking", value: "low" });
  await app.send("session/set_config_option", { sessionId, configId: "account", value: "auto" });

  const response = await app.prompt(sessionId, "продолжай");
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));
  const [req] = app.requests();
  assert.equal(req.prompt, "продолжай");
  assert.equal(req.convId, "fixture-conversation-1");
  assert.equal(req.verify, true);
  assert.equal(req.model, "pro");
  assert.equal(req.thinking, "high");
  assert.equal(req.account, "web-fixture");

  const done = turns(first.state, recs[0].key)[0].record;
  assert.equal(done.outcome, "passed");
  assert.equal(done.attempts.length, 2);
  assert.equal(done.deadlineAt, turn.deadlineAt);
  assert.equal(done.budgets.contextBytes, turn.budgets.contextBytes + Buffer.byteLength(req.prompt));
  assert.equal(done.budgets.toolRounds, 1);
  assert.equal(done.packageSha256, turn.packageSha256);
  assert.equal(readFileSync(join(journalTurnsDir(first.state, recs[0].key, 1), "answer.txt"), "utf8"), FINAL);
});

test("session/load resolves a legacy argon model in the saved session record to neon", async (t) => {
  const repo = setup(t);
  const first = fixture(t, repo, `(request) => ({ text: ${JSON.stringify(FINAL)} })`);
  const sessionId = await first.newSession();
  await first.send("session/set_model", { sessionId, modelId: "neon" });
  const response = await first.prompt(sessionId, task("Review the change", { ref: "review" }));
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));

  const [rec] = records(first.state);
  assert.equal(rec.record.model, "neon");
  journal.saveSessionRecord(first.state, rec, { model: "argon" });
  first.kill();
  await waitFor(() => first.child.exitCode !== null || first.child.signalCode !== null);

  const app = fixture(t, repo, `() => ({ text: ${JSON.stringify(FINAL)} })`, { stateDir: first.state });
  const loaded = await app.loadSession(sessionId);
  assert.ok(loaded.result, JSON.stringify(loaded.error));
  assert.equal(loaded.result.models.currentModelId, "neon", "legacy saved model must resolve to neon");
  assert.equal(
    loaded.result.configOptions.find((option) => option.id === "model")?.currentValue,
    "neon"
  );
});

test("resuming an unfinished turn with turn.profile.model:'argon' routes by neon and honors lockedModels:['neon']", async (t) => {
  const repo = setup(t);
  const first = fixture(t, repo, `(request) => request.count === 1
    ? { text: '<tool name="read_file" path="docs/notes.txt"/>' }
    : new Promise(() => {})`);
  const sessionId = await first.newSession();
  const text = task("Review the change", { ref: "review" });
  first.notifyPrompt(sessionId, text);
  await waitFor(() => first.requests().length >= 2);
  first.kill();
  await waitFor(() => first.child.exitCode !== null || first.child.signalCode !== null);

  const recs = records(first.state);
  const turnEntry = turns(first.state, recs[0].key)[0];
  assert.equal(turnEntry.record.outcome, null);

  // Set turn.profile.model to "argon" in the saved turn record
  turnEntry.record.profile = { ...(turnEntry.record.profile || {}), model: "argon", thinking: "high", account: "auto" };
  writeFileSync(
    join(journalTurnsDir(first.state, recs[0].key, 1), "turn.json"),
    JSON.stringify(turnEntry.record, null, 2)
  );

  // Configure backends: one with neon locked, one free
  const backendLocked = { id: "acc-locked", cdp: 19223, profileDir: repo.tmp, tier: "pro", priority: 10 };
  const backendFree = { id: "acc-free", cdp: 19224, profileDir: repo.tmp, tier: "pro", priority: 10 };
  const stateFile = join(first.state, "accounts-state.json");
  writeFileSync(
    stateFile,
    JSON.stringify({
      accounts: {
        "acc-locked": { lockedModels: ["neon"] },
        "acc-free": { lockedModels: [] },
      },
      leases: {},
    })
  );

  const app = fixture(t, repo, `() => ({ text: ${JSON.stringify(FINAL)} })`, {
    stateDir: first.state,
    backends: [backendLocked, backendFree],
  });
  const loaded = await app.loadSession(sessionId);
  assert.ok(loaded.result);

  const response = await app.prompt(sessionId, "продолжай");
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));

  const [req] = app.requests();
  assert.equal(req.account, "acc-free", "must skip acc-locked because neon is locked and route to acc-free");
  assert.equal(req.model, "neon", "must route by canonical model 'neon'");

  const done = turns(first.state, recs[0].key)[0].record;
  assert.equal(done.outcome, "passed");
});

test("session/load resumes by redelivering the saved package when the conversation is gone", async (t) => {
  const repo = setup(t);
  repo.write("appendix.txt", "saved attachment bytes\n");
  const link = { type: "resource_link", uri: pathToFileURL(join(repo.repo, "appendix.txt")).href, name: "appendix" };
  const first = fixture(t, repo, (request) => request.count === 1
    ? { text: '<tool name="read_file" path="docs/notes.txt"/>' }
    : new Promise(() => {}));
  const sessionId = await first.newSession();
  const text = task("Read the change and the supplied appendix");
  first.notifyPrompt(sessionId, text, [link]);
  await waitFor(() => first.requests().length >= 2);
  const packageSha = turns(first.state, records(first.state)[0].key)[0].record.packageSha256;
  first.kill();
  await waitFor(() => first.child.exitCode !== null || first.child.signalCode !== null);

  // Сохранённый разговор утерян: драйвер отвечает CONVERSATION_LOST на
  // проверку и принимает повторную доставку в новый чат.
  const app = fixture(t, repo, `(request, options) => {
    if (options.convId && options.verifyConversation) {
      const lost = new Error("gone");
      lost.code = "WEB_GEMINI_CONVERSATION_LOST";
      throw lost;
    }
    return { text: ${JSON.stringify(FINAL)} };
  }`, { stateDir: first.state });
  const loaded = await app.loadSession(sessionId);
  assert.ok(loaded.result, JSON.stringify(loaded.error));
  const response = await app.prompt(sessionId, "продолжай");
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));

  const recs = records(first.state);
  const turn = turns(first.state, recs[0].key)[0].record;
  assert.equal(turn.outcome, "passed");
  assert.equal(turn.packageSha256, packageSha);
  // Повторная доставка идёт новым чатом с полным сохранённым пакетом.
  const [verify, redelivery] = app.requests();
  assert.equal(verify.convId, "fixture-conversation-1");
  assert.equal(verify.verify, true);
  assert.ok(redelivery, "expected a fresh-chat redelivery request");
  assert.equal(redelivery.convId, null);
  assert.match(redelivery.prompt, /=== Опись \/ Manifest ===/);
  assert.match(redelivery.prompt, /=== tool: read_file/);
  assert.equal(redelivery.files[0].text, "saved attachment bytes\n");
  assert.match(redelivery.prompt, /продолжай/);
});

test("a backend change redelivers the original pinned review and attachments", async (t) => {
  const repo = setup(t);
  const resource = { type: "resource_link", uri: pathToFileURL(join(repo.repo, "docs/notes.txt")).href, name: "notes" };
  const first = fixture(t, repo, (request) => request.count === 1
    ? { text: '<tool name="read_file" path="docs/notes.txt"/>' }
    : new Promise(() => {}));
  const sessionId = await first.newSession();
  first.notifyPrompt(sessionId, task("Review the change", { ref: "review" }), [resource]);
  await waitFor(() => first.requests().length === 2);
  first.kill();
  await once(first.child, "exit");
  repo.git("branch", "-f", "review", "HEAD");

  const app = fixture(t, repo, `() => ({ text: ${JSON.stringify(FINAL)} })`, {
    stateDir: first.state,
    backends: [{ id: "alternate-fixture", cdp: 19224, profileDir: repo.tmp, tier: "pro" }],
  });
  assert.ok((await app.loadSession(sessionId)).result);
  const reply = await app.prompt(sessionId, "[orchestrator] turn interrupted (provider restarted), continue the task");
  assert.equal(reply.result?.stopReason, "end_turn", JSON.stringify(reply.error));
  const [request] = app.requests();
  assert.equal(request.convId, null);
  assert.equal(request.account, "alternate-fixture");
  assert.ok(request.prompt.includes(repo.sha));
  assert.match(request.prompt, /=== tool: read_file/);
  assert.equal(request.files[0].text, "review value\nZX12-marker\n");
});

test("the BB ACP bridge restores the original session and review after the provider restarts", async (t) => {
  const repo = setup(t);
  const first = fixture(t, repo, () => new Promise(() => {}));
  const sessionId = await first.newSession();
  first.notifyPrompt(sessionId, task("Review the original commit", { ref: "review" }));
  await waitFor(() => first.requests().length === 1);
  first.kill();
  await once(first.child, "exit");
  repo.git("branch", "-f", "review", "HEAD");

  const app = fixture(t, repo, `() => ({ text: ${JSON.stringify(FINAL)} })`, { stateDir: first.state, bridge: true });
  const restored = await app.send("thread/resume", {
    threadId, providerThreadId: sessionId, cwd: repo.repo, instructionMode: "replace", options: app.bridgeOptions,
  });
  assert.equal(restored.result?.providerThreadId, sessionId, JSON.stringify(restored.error));
  assert.equal(restored.result.sessionRestorable, true);
  const started = await app.send("turn/start", {
    threadId, providerThreadId: sessionId, clientRequestId: "creq_23456789ab",
    input: [blockText("[orchestrator] turn interrupted (provider restarted), continue the task")],
    options: app.bridgeOptions,
  });
  assert.ok(started.result, JSON.stringify(started.error));
  await waitFor(() => app.messages.flatMap((message) => message.params?.deltas ?? []).find((item) => item.kind === "item.textDelta"));
  const [request] = app.requests();
  assert.equal(request.convId, null);
  assert.match(request.prompt, /Review the original commit/);
  assert.ok(request.prompt.includes(repo.sha));
  assert.equal(turns(first.state, records(first.state)[0].key)[0].record.outcome, "passed");
});

test("session/load rejects foreign, mismatched, expired, unsupported and corrupt records", async (t) => {
  const repo = setup(t);
  const app = fixture(t, repo, () => ({ text: "unreachable" }));
  const state = app.state;
  const fp = await journal.worktreeFingerprint(repo.repo);
  const other = join(repo.tmp, "other-dir");
  mkdirSync(other, { recursive: true });
  const otherFp = await journal.worktreeFingerprint(other);

  const foreign = journal.createSessionRecord(state, { sessionId: "web-gemini-foreign", threadId: "t" + "hr_other", fingerprint: fp });
  const wrongDir = journal.createSessionRecord(state, { sessionId: "web-gemini-wrongdir", threadId, fingerprint: otherFp });
  const ceiling = journal.createSessionRecord(state, { sessionId: "web-gemini-ceiling", threadId, fingerprint: fp, accessCeiling: "accept-edits" });
  const expired = journal.createSessionRecord(state, { sessionId: "web-gemini-expired", threadId, fingerprint: fp });
  const staleFile = join(state, "inner-agent", "sessions", expired.key + ".json");
  const stale = JSON.parse(readFileSync(staleFile, "utf8"));
  stale.updatedAt = Date.now() - 25 * 3600 * 1000;
  writeFileSync(staleFile, JSON.stringify(stale));
  const corrupt = join(state, "inner-agent", "sessions", "corruptkey.json");
  writeFileSync(corrupt, "not json at all");

  for (const [id, pattern] of [
    ["web-gemini-foreign", /different owner thread/],
    ["web-gemini-wrongdir", /different working directory/],
    ["web-gemini-ceiling", /read-only ceiling/],
    ["web-gemini-expired", /expired/],
    ["corruptkey", /unknown saved session/],
    ["web-gemini-absent", /unknown saved session/],
  ]) {
    const response = await app.loadSession(id);
    assert.equal(response.error?.data?.outcome, "not_started", id);
    assert.match(response.error.message, pattern, id);
  }
  assert.equal(app.requests().length, 0, "rejected loads never reach the driver");
  const unbound = fixture(t, repo, () => ({ text: "unreachable" }), { stateDir: state, owner: false });
  const denied = await unbound.loadSession(wrongDir.record.sessionId, other);
  assert.equal(denied.error?.data?.outcome, "not_started");
  assert.match(denied.error.message, /owner thread could not be verified/);
  assert.equal(unbound.requests().length, 0);
  void foreign; void wrongDir; void ceiling;
});

test("an exact retry requires the same ACP blocks and the same validated attachment bytes", async (t) => {
  for (const kind of ["same", "embedded changed", "file contents changed", "file link changed"]) {
    await t.test(kind, async (t) => {
      const repo = setup(t);
      repo.write("appendix.txt", "original appendix\n");
      repo.write("alternative.txt", "alternative appendix\n");
      const resource = { uri: "memory:appendix", mimeType: "text/plain", text: "original embedded material" };
      const link = (name) => ({ type: "resource_link", uri: pathToFileURL(join(repo.repo, name)).href, name });
      const original = [{ type: "resource", resource }, link("appendix.txt")];
      const text = "Review the supplied sources and continue the migration";
      const first = fixture(t, repo, () => new Promise(() => {}));
      const sessionId = await first.newSession();
      first.notifyPrompt(sessionId, text, original);
      await waitFor(() => first.requests().length === 1);
      first.kill();
      await once(first.child, "exit");

      const app = fixture(t, repo, () => ({ text: "Complete result" }), { stateDir: first.state });
      assert.ok((await app.loadSession(sessionId)).result);
      if (kind === "file contents changed") repo.write("appendix.txt", "replacement appendix\n");
      const next = [
        { resource: { text: kind === "embedded changed" ? "modified embedded material" : resource.text, mimeType: resource.mimeType, uri: resource.uri }, type: "resource" },
        link(kind === "file link changed" ? "alternative.txt" : "appendix.txt"),
      ];
      const reply = await app.prompt(sessionId, text, next);
      assert.equal(reply.result?.stopReason, "end_turn", JSON.stringify(reply.error));
      const saved = turns(app.state, records(app.state)[0].key);
      const [request] = app.requests();
      if (kind === "same") {
        assert.equal(saved.length, 1);
        assert.equal(saved[0].record.attempts.length, 2);
        assert.equal(request.prompt, first.requests()[0].prompt);
      } else {
        assert.equal(saved.length, 2);
        assert.equal(saved[0].record.reason, "superseded by a new task input");
        assert.notEqual(saved[0].record.taskSha256, saved[1].record.taskSha256);
        assert.match(request.prompt, kind === "embedded changed" ? /modified embedded material/ : /original embedded material/);
        assert.equal(request.files[0].text, kind === "file contents changed" ? "replacement appendix\n"
          : kind === "file link changed" ? "alternative appendix\n" : "original appendix\n");
      }
    });
  }
});

test("restart carries forward the absolute deadline and outgoing context budget", async (t) => {
  for (const limit of ["deadline", "context bytes"]) {
    await t.test(limit, async (t) => {
      const repo = setup(t);
      const first = fixture(t, repo, () => new Promise(() => {}), { settings: { context: { maxTotalBytes: 14_000 } } });
      const sessionId = await first.newSession();
      first.notifyPrompt(sessionId, "Read the supplied material.\n" + "x".repeat(8500));
      await waitFor(() => first.requests().length === 1);
      first.kill();
      await once(first.child, "exit");

      const sessKey = records(first.state)[0].key;
      const stored = turns(first.state, sessKey)[0].record;
      const used = Buffer.byteLength(first.requests()[0].prompt);
      assert.equal(stored.budgets.contextBytes, used);
      assert.ok(used > 14_000 / 2);
      if (limit === "deadline") {
        stored.deadlineAt = Date.now() - 1;
        journal.saveTurn(first.state, sessKey, stored);
      }
      const app = fixture(t, repo, () => ({ text: "unreachable" }), {
        stateDir: first.state,
        settings: { context: { maxTotalBytes: 100_000 } },
        env: { WEB_GEMINI_SEND_DEADLINE_MS: "3000000" },
      });
      assert.ok((await app.loadSession(sessionId)).result);
      const reply = await app.prompt(sessionId, "Continue");
      assert.equal(reply.error?.data?.outcome, "failed");
      assert.match(reply.error.message, limit === "deadline" ? /deadline exceeded/ : /remaining byte budget/);
      assert.deepEqual(app.requests(), []);
      const done = turns(first.state, sessKey)[0].record;
      assert.equal(done.deadlineAt, stored.deadlineAt);
      assert.equal(done.budgets.contextBytes, used);
      assert.equal(done.budgets.maxTotalBytes, 14_000);
    });
  }
});

test("a repair requested before restart still consumes the saved round limit", async (t) => {
  const repo = setup(t);
  const first = fixture(t, repo, (request) => request.count === 1
    ? { text: "Incomplete review without a verdict" }
    : new Promise(() => {}), { settings: { apply: { maxRepairRounds: 1 } } });
  const sessionId = await first.newSession();
  first.notifyPrompt(sessionId, task("Review the change", { ref: "review" }));
  await waitFor(() => first.requests().length === 2);
  assert.match(first.requests()[1].prompt, /Correct the previous reply/);
  first.kill();
  await once(first.child, "exit");

  const app = fixture(t, repo, () => ({ text: "Still missing a verdict" }), { stateDir: first.state });
  assert.ok((await app.loadSession(sessionId)).result);
  const reply = await app.prompt(sessionId, "Continue");
  assert.equal(reply.error?.data?.outcome, "failed");
  assert.match(reply.error.message, /verdict/i);
  assert.equal(app.requests().length, 1);
  assert.equal(turns(app.state, records(app.state)[0].key)[0].record.budgets.repairRounds, 1);
});

test("each exchange atomically replaces the history file and damaged entries are visible", (t) => {
  const state = mkdtempSync(join(tmpdir(), "web-gemini-exchange-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const session = journal.createSessionRecord(state, { sessionId: "fixture" });
  const turn = journal.createTurn(state, session, {});
  const history = join(journalTurnsDir(state, session.key, turn.turnNo), "exchanges.jsonl");
  journal.appendExchange(state, session.key, turn, { kind: "reply", text: "first" });
  const inode = statSync(history).ino;
  journal.appendExchange(state, session.key, turn, { kind: "tool-result", text: "second" });
  assert.notEqual(statSync(history).ino, inode);
  assert.deepEqual(journal.readExchanges(state, session.key, turn.turnNo).map(({ text }) => text), ["first", "second"]);
  writeFileSync(history, "{");
  assert.throws(() => journal.readExchanges(state, session.key, turn.turnNo), /incomplete/);
});

test("continuation detection recognizes stock watchdog messages and preserves new instructions", () => {
  for (const text of [
    "продолжай",
    "Continue the task.",
    "[orchestrator] ход прерван (внешняя отмена), продолжай задачу",
    "[orchestrator] the turn died on an error: provider unavailable. Continue the task",
    '[orchestrator] заверши вердиктом: дождись проверок в этом же ходе (не фоном) и закончи строкой JSON {"verdict":"OK"|"CHANGES","blockers":N}',
  ]) assert.equal(journal.isContinueText(text), true, text);
  for (const text of [
    "Continue the migration by reading docs/notes.txt",
    "Проверь, почему был прерван экспорт",
    "Implement automatic resume on interrupt",
  ]) assert.equal(journal.isContinueText(text), false, text);
});

test("a bare continue without a saved turn is rejected instead of starting an empty task", async (t) => {
  const repo = setup(t);
  const app = fixture(t, repo, () => ({ text: "unreachable" }));
  const sessionId = await app.newSession();
  const response = await app.prompt(sessionId, "продолжай");
  assert.equal(response.error?.data?.outcome, "not_started");
  assert.match(response.error.message, /no saved task package/);
  assert.equal(app.requests().length, 0);
});

test("session/new adopts the single saved record for the same thread and directory", async (t) => {
  const repo = setup(t);
  const first = fixture(t, repo, () => new Promise(() => {}));
  const sessionId = await first.newSession();
  first.notifyPrompt(sessionId, task("Review the change", { ref: "review" }));
  await waitFor(() => first.requests().length >= 1);
  first.kill();
  await waitFor(() => first.child.exitCode !== null || first.child.signalCode !== null);

  const app = fixture(t, repo, `(request) => {
    if (request.convId !== null) throw new Error("undelivered turn must redeliver into a new chat");
    return { text: ${JSON.stringify(FINAL)} };
  }`, { stateDir: first.state });
  const newId = await app.newSession();
  assert.notEqual(newId, sessionId);
  const response = await app.prompt(newId, "продолжай");
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));
  const recs = records(first.state);
  assert.equal(recs.length, 1);
  assert.ok(recs[0].record.aliases.includes(newId));
  assert.match(app.requests()[0].prompt, /=== Опись \/ Manifest ===/);
});

test("pruneJournal removes expired records, keeps active turns, and bounds record count", async (t) => {
  const repo = setup(t);
  const state = mkdtempSync(join(repo.tmp, "journal-"));
  const fp = await journal.worktreeFingerprint(repo.repo);

  // Просроченная завершённая запись — удаляется.
  const old = journal.createSessionRecord(state, { sessionId: "web-gemini-old", threadId, fingerprint: fp });
  const oldFile = join(state, "inner-agent", "sessions", old.key + ".json");
  const stale = JSON.parse(readFileSync(oldFile, "utf8"));
  stale.updatedAt = Date.now() - 48 * 3600 * 1000;
  writeFileSync(oldFile, JSON.stringify(stale));

  // Активная запись с незавершённым ходом — защищена даже при истёкшем сроке.
  const active = journal.createSessionRecord(state, { sessionId: "web-gemini-active", threadId, fingerprint: fp });
  journal.createTurn(state, active, { inputSha256: "a".repeat(64), mode: "read-only" });
  const activeFile = join(state, "inner-agent", "sessions", active.key + ".json");
  const staleActive = JSON.parse(readFileSync(activeFile, "utf8"));
  staleActive.updatedAt = Date.now() - 48 * 3600 * 1000;
  writeFileSync(activeFile, JSON.stringify(staleActive));

  const kept = journal.createSessionRecord(state, { sessionId: "web-gemini-kept", threadId, fingerprint: fp });
  void kept;

  let stats = journal.pruneJournal(state, { retentionMs: 3600 * 1000, maxRecords: 200 });
  assert.ok(stats.removedSessions >= 1);
  assert.ok(!existsSync(oldFile), "expired completed record removed");
  assert.ok(existsSync(activeFile), "active record kept despite expiry");
  assert.ok(existsSync(join(state, "inner-agent", "turns", active.key, "turn-0001", "record.json")));

  // Лимит записей: лишние уходят с конца по updatedAt, активные не трогаем.
  for (let i = 0; i < 5; i += 1) {
    journal.createSessionRecord(state, { sessionId: "web-gemini-extra-" + i, threadId, fingerprint: fp });
  }
  stats = journal.pruneJournal(state, { retentionMs: 24 * 3600 * 1000, maxRecords: 3 });
  const left = records(state);
  assert.equal(left.length, 3);
  assert.ok(left.some((entry) => entry.key === active.key), "active record survives the limit");
});
