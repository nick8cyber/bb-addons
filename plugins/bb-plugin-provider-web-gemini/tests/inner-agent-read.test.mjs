import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { EN } from "../../bb-plugin-orchestrator/src/i18n/en.ts";
import { RU } from "../../bb-plugin-orchestrator/src/i18n/ru.ts";

const server = new URL("../acp-server.mjs", import.meta.url).href;
const threadId = "t" + "hr_" + "fixture123";
const projectId = "p" + "roj_" + "fixture123";
const key = "EX" + "AMPLE-" + "42";
const attachmentId = "0".repeat(25) + "1";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const interpolate = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => values[name]);
const blockText = (text) => ({ type: "text", text });
const replyText = (messages) => messages.map((message) => message.params?.update)
  .filter((update) => update?.sessionUpdate === "agent_message_chunk")
  .map((update) => update.content.text).join("");

function setup(t) {
  const tmp = mkdtempSync(join(tmpdir(), "web-gemini-read-"));
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
  write("docs/long.txt", Array.from({ length: 3200 }, (_, i) => "review line " + i + " " + "x".repeat(16)).join("\n") + "\nDIFF END\n");
  write("private/.env.review", "HIDDEN PATH CONTENT\n");
  write("nested/dist/artifact.txt", "HIDDEN GENERATED CONTENT\n");
  write("nested/node_modules/library.txt", "HIDDEN DEPENDENCY CONTENT\n");
  write("package-lock.json", "HIDDEN LOCK CONTENT\n");
  write("generated/dep-lock.yaml", "HIDDEN LOCK CONTENT\n");
  write("picture.bin", Buffer.from([0, 120, 255]));
  write(".gitattributes", "forced.bin diff\n");
  write("forced.bin", Buffer.from([0, 121, 254]));
  symlinkSync("notes.txt", join(repo, "docs/symlink.txt"));
  git("add", ".");
  git("commit", "-m", "Review");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/wrong", sha);

  git("switch", "main");
  write("docs/notes.txt", "different HEAD\n");
  write("docs/base-only.txt", "different HEAD\n");
  git("add", ".");
  git("commit", "-m", "Independent HEAD");
  const head = git("rev-parse", "HEAD");
  return { tmp, repo, git, write, sha, base, head };
}

function task(text, dictionary, { ref, paths, tracker = false } = {}) {
  const review = ref ? interpolate(dictionary["instr.reviewRound"], {
    from: ref,
    tail: " (" + interpolate(dictionary["instr.reviewBranch"], { branch: "review" }) + ", " +
      interpolate(dictionary["instr.reviewRoundN"], { round: 2 }) + ")",
  }) : "";
  const attached = paths ? interpolate(dictionary["instr.attachList"], { list: paths.join(", ") }) : "";
  return [
    "# " + key + " · Audit fixture", "## Description", text,
    "## Attachments", tracker ? "- tracker.md · " + attachmentId + "\n  Fetch with: bb tasks attachment get " + attachmentId + " --out <path>" : "None.",
    "## Additional instructions", [review, attached].filter(Boolean).join("\n"),
  ].join("\n\n");
}

async function waitFor(predicate, seconds = 7) {
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
  return { messages, send, notify };
}

function fixture(t, repo, model, options = {}) {
  const dir = mkdtempSync(join(repo.tmp, "instance-"));
  const cli = join(dir, "bb-fixture.mjs");
  const state = join(dir, "state");
  const requests = join(dir, "requests.jsonl");
  mkdirSync(state);
  if (options.settings) writeFileSync(join(state, "inner-agent.json"), JSON.stringify(options.settings));
  if (options.badUploadDir) writeFileSync(join(state, "uploads"), "unavailable directory");
  const quoted = JSON.stringify;
  writeFileSync(cli, "#!/usr/bin/env node\n" + String.raw`
import { writeFileSync } from "node:fs";
const [area, action, arg, ...extra] = process.argv.slice(2);
const threadId = ${quoted(threadId)};
const projectId = ${quoted(projectId)};
if (area === "thread" && action === "show" && arg === threadId && extra[0] === "--json") {
  console.log(JSON.stringify({
    thread: { id: threadId, projectId, originPluginId: ${quoted(options.chat ? null : "fixture-orchestrator")} },
    environment: { path: ${quoted(options.mismatchedCwd ?? repo.repo)}, ...${quoted(options.environment ?? { mergeBaseBranch: "base", baseBranch: "wrong" })} },
  }));
} else if (area === "tasks" && action === "show" && extra[0] === "--json") {
  console.log(JSON.stringify({
    task: { key: arg }, project: { linkedBbProjectId: projectId }, taskThreads: [{ threadId }],
    attachments: [{ id: ${quoted(attachmentId)}, fileName: "tracker.md" }],
  }));
} else if (area === "tasks" && action === "attachment" && arg === "get" && extra[0] === ${quoted(attachmentId)} && extra[1] === "--out") {
  writeFileSync(extra[2], "Tracker input ZX12-marker\n");
} else if (area === "thread" && action === "log" && arg === threadId && extra[0] === "--message" && extra[1] === "2") {
  console.log("Linked material ZX12-marker");
} else process.exitCode = 2;
`);
  chmodSync(cli, 0o700);
  const entry = join(dir, "server-fixture.mjs");
  writeFileSync(entry, `
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from ${quoted(server)};
let count = 0;
startServer({ webDriver: { async sendPrompt(options) {
  const files = (options.files ?? []).map((path) => ({ path, text: readFileSync(path, "utf8"), data: readFileSync(path).toString("base64") }));
  const request = { prompt: options.prompt, files, convId: options.convId, strict: options.requireFullDelivery, count: ++count };
  appendFileSync(${quoted(requests)}, JSON.stringify(request) + "\\n");
  options.onSubmitted?.();
  options.onChunk?.("fixture pre-validation text");
  const response = await (${model})(request, options, ${quoted({ cwd: repo.repo, head: repo.head })});
  return { convId: options.convId || "fixture-conversation", ...response };
} } });
`);
  const { messages, send, notify } = rpcProcess(t, [entry, "--session-access=read-only", "--bb-thread-id=" + threadId], {
    ...process.env,
    BB_CLI: cli, WEB_GEMINI_FAKE: "0", ARGON_FAKE: "0",
    WEB_GEMINI_STATE_DIR: state, WEB_GEMINI_POOL_FILE: join(dir, "absent"),
    WEB_GEMINI_BACKENDS: JSON.stringify([{ id: "web-fixture", cdp: 19223, profileDir: dir, tier: "pro" }]),
    ...options.env,
  });
  return {
    messages, send, notify, state,
    requests: () => existsSync(requests) ? readFileSync(requests, "utf8").trimEnd().split("\n").map(JSON.parse) : [],
    newSession: async (cwd = repo.repo) => {
      const response = await send("session/new", { cwd });
      assert.deepEqual(response.result.modes.availableModes.map((mode) => mode.id), ["read-only"]);
      return response.result.sessionId;
    },
    prompt: (sessionId, text, extra = []) => send("session/prompt", { sessionId, prompt: [...extra, blockText(text)] }),
  };
}

function delivered(request) {
  const content = request.files.find((file) => file.text.includes("=== Опись / Manifest ==="))?.text ?? request.prompt;
  const marker = "=== Опись / Manifest ===\n";
  const at = content.lastIndexOf(marker);
  assert.ok(at >= 0, "provider manifest is part of the delivered package");
  const [summary, ...json] = content.slice(at + marker.length).trimEnd().split("\n");
  const manifest = JSON.parse(json.join("\n"));
  const body = Buffer.from(content.slice(content.indexOf("=== Task text ===\n"), at));
  const materials = new Map();
  for (const item of manifest.included) {
    const file = request.files.find((file) => file.path.endsWith("/" + item.delivery));
    const data = (file ? Buffer.from(file.data, "base64") : body).subarray(...item.range);
    assert.equal(data.length, item.bytes, item.source);
    assert.equal(digest(data), item.sha256, item.source);
    materials.set(item.name ?? item.source, data.toString());
  }
  assert.equal(digest(JSON.stringify(manifest.included.map(({ range, delivery, ...item }) => item))), manifest.coreSha256);
  assert.equal(manifest.included[0].sha256, manifest.taskSha256);
  return { manifest, summary, materials, content };
}

test("real BB generic ACP bridge retains tool progress before any assistant text", async (t) => {
  const sdk = dirname(fileURLToPath(import.meta.resolve("@get-bb/plugin-sdk/provider-bridge/acp")));
  const dir = mkdtempSync(join(tmpdir(), "web-gemini-bridge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agent = join(dir, "agent.mjs");
  writeFileSync(agent, String.raw`
import { createInterface } from "node:readline";
const send = (event) => process.stdout.write(JSON.stringify({ jsonrpc:"2.0", ...event }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { method, id } = JSON.parse(line);
  const sessionId = "fixture-session";
  const reply = (result) => send({ id, result });
  const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
  if (method === "initialize") reply({ protocolVersion: 1, agentCapabilities: {} });
  if (method === "session/new") reply({ sessionId, modes: { currentModeId:"read-only", availableModes:[{id:"read-only",name:"Read only"}] } });
  if (method === "session/prompt") {
    const toolCallId = "fixture-progress";
    update({ sessionUpdate:"tool_call", toolCallId, kind:"other", status:"in_progress", title:"Read task" });
    update({ sessionUpdate:"tool_call_update", toolCallId, status:"in_progress", content:[{type:"content", content:{type:"text",text:"generation"}}] });
    setTimeout(() => {
      update({ sessionUpdate:"tool_call_update", toolCallId, status:"completed" });
      update({ sessionUpdate:"agent_message_chunk", content:{type:"text",text:"finished"} });
      reply({ stopReason:"end_turn" });
    }, 200);
  }
});
`);
  const worker = join(sdk, "provider-bridge-worker-entry.mjs");
  const host = fileURLToPath(new URL("../host.mjs", import.meta.url));
  const bridge = rpcProcess(t, [worker, host, "provider-fixture", dir], process.env);
  const options = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null,
    providerOptions: { acpDialect: "generic", acpLaunchSpec: { displayName: "Fixture", command: process.execPath,
      args: [agent], env: {}, permissionCli: { insertAfterArgs: 1, full: ["--session-access=read-only"] } } } };
  const start = await bridge.send("thread/start", { threadId, cwd: dir, instructionMode: "replace", options });
  assert.ok(start.result, JSON.stringify(start.error));
  await bridge.send("turn/start", {
    threadId, providerThreadId: start.result.providerThreadId, clientRequestId: "creq_23456789ab",
    input: [blockText("Review")], options,
  });
  const deltas = () => bridge.messages.flatMap((message) => message.params?.deltas ?? []);
  await waitFor(() => deltas().find((delta) => delta.kind === "item.textDelta"));
  const events = deltas();
  const opened = events.findIndex((delta) => delta.kind === "item.open" && delta.item.type === "tool");
  const progress = events.findIndex((delta) => delta.kind === "item.progress" && delta.message === "generation");
  assert.ok(opened >= 0 && progress > opened && progress < events.findIndex((delta) => delta.kind === "item.textDelta"));
  assert.deepEqual(events[opened].key, events[progress].key);
});

// Supply a raw bb thread log from the isolated, slow ACP fixture to exercise
// the real watchdog's event consumer and silence timer against the BB journal.
if (process.env.WEB_GEMINI_TEST_BB_JOURNAL) {
  test("BB journal progress advances the orchestrator watchdog before assistant text", async () => {
    await import("../../bb-plugin-orchestrator/tests/register-hooks.ts");
    const { DatabaseSync } = await import("node:sqlite");
    const { DelegationStore, MIGRATIONS } = await import("../../bb-plugin-orchestrator/src/store.ts");
    const { createWatchdog } = await import("../../bb-plugin-orchestrator/src/watchdog.ts");
    const journal = JSON.parse(readFileSync(process.env.WEB_GEMINI_TEST_BB_JOURNAL, "utf8"));
    const opened = journal.find((event) => event.type === "item/started" && event.data.item?.type === "toolCall");
    const updates = journal.filter((event) => event.type === "item/toolCall/progress" && event.data.itemId === opened.data.item.id);
    assert.ok(updates.length >= 2);
    const [first, ...rest] = updates;
    const last = rest.at(-1);
    const firstText = journal.find((event) => event.type === "item/agentMessage/delta");
    assert.ok(opened.seq < first.seq && last.seq < firstText.seq);
    assert.ok(last.createdAt - first.createdAt > 10_000);

    const db = new DatabaseSync(":memory:");
    try {
      for (const migration of MIGRATIONS) db.exec(migration);
      // DelegationStore uses the better-sqlite3 transaction signature.
      db.transaction = (operation) => () => {
        db.exec("BEGIN");
        try {
          const result = operation();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      };
      const store = new DelegationStore(db);
      const row = store.insert({ taskKey: key, projectId, coordinatorThreadId: "fixture-coordinator",
        level: "review", route: "fixture", preset: "fixture", provider: "acp-web-gemini" });
      store.setThreadInfo(row.id, opened.threadId);
      store.setStatus(row.id, "running");
      const thread = { id: opened.threadId, status: "active" };
      let through = first.seq;
      let now = first.createdAt;
      const watchdog = createWatchdog({
        store, loadPolicy: async () => ({ policy: { routes: {}, firstResponseSeconds: 1 } }), enqueue: (work) => work(),
        now: () => now,
        threads: {
          get: async () => thread,
          events: { list: async ({ afterSeq = 0 }) => journal.filter(({ seq }) => seq > Number(afterSeq) && seq <= through) },
          stop: async () => assert.fail("watchdog stopped a live turn"),
        },
        dispatch: async () => assert.fail("watchdog reissued a live turn"),
      });
      await watchdog.onThreadEvents({ thread });
      assert.equal(store.get(row.id).first_response_at, opened.createdAt);
      through = last.seq;
      now = last.createdAt;
      await watchdog.onThreadEvents({ thread });
      assert.equal(store.get(row.id).last_response_at, last.createdAt);
      await watchdog.checkTimers();
      assert.equal(store.get(row.id).status, "running");
    } finally {
      db.close();
    }
  });
}

test("live RU/EN task templates pin branch or SHA, pack the complete review and read the same Git objects", async (t) => {
  const repo = setup(t);
  const model = (request, _options, repo) => {
    if (request.count === 1) {
      execFileSync("git", ["update-ref", "refs/heads/review", repo.head], { cwd: repo.cwd });
      return { text: [
        '<tool name="read_file" path="docs/notes.txt"/>',
        '<tool name="list_dir" path="docs"/>',
        '<tool name="grep" path="docs" pattern="review value"/>',
        '<tool name="git" args="diff --stat"/>',
        '<tool name="git" args="show HEAD:docs/notes.txt"/>',
        '<tool name="read_file" path="docs/symlink.txt"/>',
      ].join("\n") };
    }
    if (request.count === 2) return { text: '<tool name="git" args="log -1"/>' };
    return { text: "Reviewed\n{\"verdict\":\"OK\",\"blockers\":0}" };
  };
  const masked = "ZX12-marker";
  const settings = { context: { maskPatterns: { [projectId]: [{ type: "project", pattern: "ZX[0-9]+-marker" }] } } };
  const packages = [];
  for (const [dict, ref] of [[RU, "review"], [EN, repo.sha]]) {
    const app = fixture(t, repo, model, { settings, env: { WEB_GEMINI_MAX_PROMPT_BYTES: "8500" } });
    const session = await app.newSession();
    const text = task("Review " + "Ж".repeat(6000) + "\nTASK END\nhttps://example.invalid/context", dict, {
      ref, paths: ["docs/notes.txt"], tracker: true,
    });
    const response = await app.prompt(session, text, [
      { type: "resource", resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "Embedded " + masked } },
    ]);
    assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));
    const [first, tools, log] = app.requests();
    assert.equal(first.strict, true);
    assert.ok(first.files.length === 2 && Buffer.byteLength(first.prompt) <= 8500);
    const actual = delivered(first);
    packages.push(actual);
    assert.equal(actual.summary, "проверяемый коммит: " + repo.sha);
    assert.equal(actual.manifest.mergeBase, repo.base);
    assert.ok(actual.materials.get("Task text").includes("TASK END"));
    assert.ok(actual.materials.get("Git review diff -U10").includes("DIFF END"));
    assert.ok(actual.materials.get("Git review diff --stat").includes("picture.bin"));
    assert.ok(actual.materials.get("Git review diff --stat").includes("forced.bin"));
    assert.doesNotMatch(actual.materials.get("Git review diff -U10"), /^diff --git .*(?:forced|picture)\.bin/m);
    assert.match(actual.materials.get("docs/notes.txt"), /^review value/);
    assert.equal(actual.materials.get("tracker.md"), "Tracker input [скрыто: project]\n");
    assert.match(actual.content, /unsupported URL/);
    assert.match(actual.content, /sensitive paths \(1\)/);
    assert.match(actual.content, /binary, stat only/);
    assert.match(actual.content, /lock file/);
    assert.match(actual.content, /generated\/dependency tree/);
    assert.doesNotMatch(actual.content, /HIDDEN|\.env\.review|different HEAD|ZX12-marker/);
    const results = tools.files[0]?.text ?? tools.prompt;
    assert.equal(tools.convId, "fixture-conversation");
    assert.equal(log.convId, tools.convId);
    assert.match(results, /"revision":"[0-9a-f]+"/);
    assert.match(results, /review value/);
    assert.match(results, /docs\/review-only\.txt/);
    assert.match(results, /"docs\/notes.txt":1:review value/);
    assert.match(results, /picture\.bin/);
    assert.match(results, /show HEAD:docs\/notes\.txt/);
    assert.match(results, /request denied or unavailable/);
    assert.doesNotMatch(results, /different HEAD|base-only|ZX12-marker/);
    assert.match(log.prompt, new RegExp(repo.sha + " Review"));
    assert.equal(replyText(app.messages), "Reviewed\n{\"verdict\":\"OK\",\"blockers\":0}");
    assert.equal(app.messages.some((message) => /pre-validation/.test(JSON.stringify(message))), false);
  }
  assert.equal(packages[0].materials.get("Git review diff -U10"), packages[1].materials.get("Git review diff -U10"));
  assert.equal(packages[0].materials.get("Git review diff --stat"), packages[1].materials.get("Git review diff --stat"));
});

test("base fallback, unavailable/conflicting/ambiguous refs and untrusted workdir", async (t) => {
  const repo = setup(t);
  repo.git("tag", "ambiguous", repo.sha);
  repo.git("branch", "ambiguous", repo.head);
  const app = fixture(t, repo, () => ({ text: 'Last line\n{"verdict":"OK","blockers":0}' }), { environment: {} });
  const session = await app.newSession();
  for (const ref of ["missing", "ambiguous", "--help", "HEAD:docs/notes.txt"]) {
    const rejection = await app.prompt(session, task("Review", EN, { ref }));
    assert.equal(rejection.error?.data?.outcome, "not_started");
    assert.match(rejection.error.message, /^\[web-gemini:not_started\]/);
  }
  const extra = interpolate(EN["instr.reviewRound"], { from: repo.head, tail: "" });
  const conflict = await app.prompt(session, task("Review", EN, { ref: repo.sha }) + "\n" + extra);
  assert.match(conflict.error?.message ?? "", /conflicting review commits/);
  assert.deepEqual(app.requests(), []);
  assert.equal((await app.prompt(session, task("Review", EN, { ref: repo.sha }))).result?.stopReason, "end_turn");
  assert.equal(delivered(app.requests()[0]).manifest.mergeBase, repo.base);

  const wrong = fixture(t, repo, () => ({ text: "unreachable" }), { mismatchedCwd: repo.tmp });
  assert.equal((await wrong.prompt(await wrong.newSession(), "Review")).error?.data.outcome, "not_started");
});

test("auditor role contracts work in both languages and raw response wins over page text", async (t) => {
  const repo = setup(t);
  const verdict = '  { "verdict": "CHANGES", "blockers": 2 }  ';
  const app = fixture(t, repo, (request) => request.count === 1 ? {
    text: "Rendered line\ninvalid",
    rawText: 'Raw report with **Markdown**\n  { "verdict": "CHANGES", "blockers": 2 }  ',
  } : { text: 'Final page result\n{"verdict":"OK","blockers":0}' });
  const session = await app.newSession();
  const system = (dict) => blockText("<system_instructions>\nSERVICE TEXT\n" + dict["role.mand.auditor"] + "\n</system_instructions>");
  const first = await app.prompt(session, task("Review text\n\n## Файлы результата\n\n- docs/notes.txt", RU), [system(RU)]);
  assert.equal(first.result?.stopReason, "end_turn", JSON.stringify(first.error));
  assert.equal(replyText(app.messages), "Raw report with **Markdown**\n" + verdict);
  const second = await app.prompt(session, task("Review text", EN), [system(EN)]);
  assert.equal(second.result?.stopReason, "end_turn", JSON.stringify(second.error));
  assert.match(replyText(app.messages), /Final page result\n\{"verdict":"OK","blockers":0\}$/);
  for (const request of app.requests()) {
    assert.match(request.prompt, /Договор вердикта \/ Verdict contract/);
    assert.doesNotMatch(request.prompt, /SERVICE TEXT|system_instructions/);
    assert.equal(delivered(request).summary, "проверяемый коммит: не указан, упакована рабочая копия");
  }
});

test("repairs missing or invalid verdicts, validates additional fields, and stops at the repair limit", async (t) => {
  const repo = setup(t);
  const model = (request) => ({
    text: request.count === 2 ? 'Report\n{"verdict":"OK","blockers":0,"target":"code"}' :
      'Report\n{"verdict":"OK","blockers":0,"target":"other"}',
  });
  const input = 'End with JSON {"verdict":"OK"|"CHANGES","blockers":N,"target":"code"|"design"}';
  const app = fixture(t, repo, model, { settings: { apply: { maxRepairRounds: 1 } } });
  const session = await app.newSession();
  assert.equal((await app.prompt(session, task(input, EN))).result?.stopReason, "end_turn");
  const failure = await app.prompt(session, task(input, EN));
  assert.equal(failure.error?.data.outcome, "failed");
  assert.match(failure.error.message, /^\[web-gemini:failed\].*additional required verdict field/);
  assert.equal(app.requests().length, 4);
  assert.equal(app.requests()[1].convId, "fixture-conversation");
  assert.match(app.requests()[1].prompt, /Correct the previous reply.+additional required verdict/s);
  assert.match(app.requests()[1].prompt, /"target": "code" \| "design"/);
  assert.doesNotMatch(replyText(app.messages), /other/);
});

test("tool-round limit requests a final answer and a continuing tool response fails", async (t) => {
  const repo = setup(t);
  const app = fixture(t, repo, () => ({ text: '<tool name="read_file" path="docs/notes.txt"/>' }), {
    env: { WEB_GEMINI_MAX_TOOL_ROUNDS: "1" },
    settings: { apply: { maxRepairRounds: 0 } },
  });
  const result = await app.prompt(await app.newSession(), task("Review", EN, { ref: repo.sha }));
  assert.equal(result.error?.data.outcome, "failed");
  assert.equal(app.requests().length, 3);
  assert.match(app.requests()[2].prompt, /Лимит раундов инструментов \(1\) исчерпан/);
  assert.equal(replyText(app.messages), "");
});

test("required delivery errors, upload limits, binary task content and write attempts do not pass", async (t) => {
  const repo = setup(t);
  const settings = { context: { maxTotalBytes: 2000 } };
  const small = fixture(t, repo, () => ({ text: "unreachable" }), { settings });
  const overflow = await small.prompt(await small.newSession(), task("x".repeat(3000), EN));
  assert.equal(overflow.error?.data.outcome, "failed");
  assert.match(overflow.error.message, /byte budget/);
  assert.deepEqual(small.requests(), []);
  const noSpill = fixture(t, repo, () => ({ text: "unreachable" }), { badUploadDir: true, env: { WEB_GEMINI_MAX_PROMPT_BYTES: "7500" } });
  const spillFailure = await noSpill.prompt(await noSpill.newSession(), task("x".repeat(14000), EN));
  assert.equal(spillFailure.error?.data.outcome, "failed");
  assert.deepEqual(noSpill.requests(), []);

  const upload = fixture(t, repo, () => {
    throw Object.assign(new Error("local path must stay private"), { code: "WEB_GEMINI_DELIVERY_FAILED" });
  });
  const session = await upload.newSession();
  const rejected = await upload.prompt(session, task("Review", EN, { tracker: true }));
  assert.equal(rejected.error?.data.outcome, "failed");
  assert.match(rejected.error.message, /could not be delivered/);
  assert.doesNotMatch(rejected.error.message, /local path/);

  const pic = join(repo.repo, "test-image.png");
  writeFileSync(pic, Buffer.from([0, 120, 255]));
  const limited = fixture(t, repo, () => ({ text: "unreachable" }), { env: { WEB_GEMINI_MAX_UPLOAD_BYTES: "2" } });
  const tooLarge = await limited.prompt(await limited.newSession(), task("Review", EN, { tracker: true }));
  assert.equal(tooLarge.error?.data.outcome, "failed");
  const writable = fixture(t, repo, () => ({ text: '{"format":"web-gemini-files-v1","files":[{"path":"docs/new.txt"}]}' }));
  const id = await writable.newSession();
  for (const modeId of ["write", "bypass", "full"]) {
    const result = await writable.send("session/set_mode", { sessionId: id, modeId });
    assert.equal(result.error?.data.outcome, "not_started");
  }
  assert.deepEqual((await writable.send("session/set_mode", { sessionId: id, modeId: "read-only" })).result, {});
  const taskImage = await writable.prompt(id, task("Review", EN), [{ type: "image", path: pic }]);
  assert.equal(taskImage.error?.data.outcome, "failed");
  assert.match(taskImage.error.message, /binary/);
  const fileResponse = await writable.prompt(id, task("Review", EN));
  assert.equal(fileResponse.error?.data.outcome, "failed");
  assert.match(fileResponse.error.message, /read-only/);
  assert.equal(replyText(writable.messages), "");
  assert.equal(existsSync(join(repo.repo, "docs/new.txt")), false);

  const chat = fixture(t, repo, () => ({ text: "chat response" }), { chat: true });
  assert.equal((await chat.prompt(await chat.newSession(), "Describe the image", [{ type: "image", path: pic }])).result?.stopReason, "end_turn");
  assert.equal(chat.requests()[0].files[0].data, readFileSync(pic).toString("base64"));
  assert.equal(chat.requests()[0].strict, false);
});

test("a smaller live textbox limit spills the same complete package before retrying", async (t) => {
  const repo = setup(t);
  const app = fixture(t, repo, (request) => {
    if (request.count === 1) throw Object.assign(new Error("textbox limit"), {
      code: "WEB_GEMINI_PROMPT_TOO_LARGE", maxPromptBytes: 2500,
    });
    return { text: "Complete answer" };
  });
  assert.equal((await app.prompt(await app.newSession(), task("c".repeat(6000), EN))).result?.stopReason, "end_turn");
  const [inline, spill] = app.requests();
  assert.equal(inline.files.length, 0);
  assert.equal(spill.files.length, 1);
  assert.ok(Buffer.byteLength(spill.prompt) <= 2500);
  assert.equal(delivered(spill).manifest.coreSha256, delivered(inline).manifest.coreSha256);
  assert.equal(delivered(spill).materials.get("Task text"), delivered(inline).materials.get("Task text"));
});

test("watchdog progress spans a slow generation, stops on completion and cancellation is per session", async (t) => {
  const repo = setup(t);
  const model = async (request, options) => {
    const waiting = request.prompt.includes("wait here");
    await delay(waiting ? 1000 : 110, null, { signal: options.signal });
    return { text: "complete answer" };
  };
  const app = fixture(t, repo, model, { settings: { progressIntervalMs: 25 } });
  const one = await app.newSession();
  const two = await app.newSession();
  const updates = (id) => app.messages.filter((message) => message.params?.sessionId === id).map((message) => message.params.update);
  const preflight = app.prompt(one, task("Cancel before preflight", EN, { ref: repo.sha }));
  app.notify("session/cancel", { sessionId: one });
  assert.equal((await preflight).error?.data.outcome, "not_started");
  const prior = updates(one).length;
  const promptOne = app.prompt(one, task("wait here", EN));
  await waitFor(() => updates(one).filter((update) => /^generation/.test(update.content?.[0]?.content?.text ?? "")).length >= 3);
  assert.equal(replyText(app.messages), "");
  const promptTwo = app.prompt(two, task("short", EN));
  await waitFor(() => updates(two).filter((update) => /^queue/.test(update.content?.[0]?.content?.text ?? "")).length >= 2);
  app.notify("session/cancel", { sessionId: one });
  assert.equal((await promptOne).result?.stopReason, "cancelled");
  assert.equal((await promptTwo).result?.stopReason, "end_turn");
  assert.equal(replyText(app.messages), "complete answer");
  const first = updates(one).slice(prior);
  const serviceId = first[0].toolCallId;
  assert.equal(first[0].sessionUpdate, "tool_call");
  assert.equal(first[1].toolCallId, serviceId);
  assert.ok(first.some((update) => update.status === "in_progress" && /^\[web-gemini:failed\] cancelled/.test(update.content?.[0]?.content?.text)));
  assert.equal(first.at(-1).status, "failed");
  const last = app.messages.length;
  await delay(120);
  assert.equal(app.messages.length, last);
});

test("project mask covers the orchestrator packet rules and outbound linked material", async (t) => {
  await import("../../bb-plugin-orchestrator/tests/register-hooks.ts");
  const { maskLeakText } = await import("../../bb-plugin-orchestrator/src/scan.ts");
  const repo = setup(t);
  const fragments = [
    "gh" + "p_" + "x".repeat(16), "qa" + "@gma" + "il.com", "/" + "home/" + "fake" + "/test",
    ["192", "168", "45", "67"].join("."), threadId, projectId, key, hostname(),
  ].filter((value) => value.length > 2);
  const text = fragments.join("\n");
  const reference = maskLeakText(text, { hostname: hostname(), threadIds: false, allowedEmails: ["example.invalid"], allow: ["public/"], file: "docs/notes.txt" });
  assert.equal(reference.count, fragments.length);
  const app = fixture(t, repo, () => ({ text: "Clean report" }), {
    settings: { context: { maskPatterns: { [projectId]: [{ type: "project", pattern: "ZX[0-9]+-marker" }] } } },
  });
  const session = await app.newSession();
  const mention = "@thread:" + threadId + "#msg=2";
  assert.equal((await app.prompt(session, task(text + "\n" + mention, EN))).result?.stopReason, "end_turn");
  const request = app.requests()[0];
  const outbound = [request.prompt, ...request.files.map((file) => file.text)].join("\n");
  for (const fragment of fragments) assert.equal(outbound.includes(fragment), false);
  assert.match(outbound, /Linked material \[скрыто: project\]/);
});

test("audit fixes: response ISO/RFC/CVE tokens pass, git show on multi-commit branch, grep -E, attachments section, and slog logs", async (t) => {
  const { checkedAnswer, loadSettings, prepareTask } = await import("../src/inner-context.mjs");
  const { collectDiff, executePinned, pinReview } = await import("../src/review-git.mjs");
  const { collectGeneratedFiles } = await import("../src/gemini-driver.js");

  const repo = setup(t);

  // 1. Blocker 1: Outbound task-key masking matches orchestrator parity (masking ES-12),
  // while response does not trigger repair on technical tokens (ISO-8601, CVE, ES-2022) or task keys.
  const settings = loadSettings(repo.tmp, projectId);
  assert.equal(settings.mask("ES-12 fix"), "[скрыто: task-key] fix", "outgoing task key must be masked");
  assert.equal(settings.mask("CSS-4 style"), "[скрыто: task-key] style", "outgoing task key must be masked");
  assert.equal(settings.mask("ISO-8601 standard"), "[скрыто: task-key] standard", "outgoing ISO token must be masked as task-key");
  assert.equal(settings.mask("SHA-256 hash"), "SHA-256 hash", "standard hash token must not be masked");

  const context = { settings, verdict: null };
  const resp = { text: "Verified dates in ISO-8601 and RFC-3339; fixed CVE-2024-1234 on HTTP-2 and ES-2022. Related to PLUG-327." };
  const checked = checkedAnswer(context, resp);
  assert.equal(checked.repair, undefined, "standard technical tokens and task keys must not trigger repair in response");
  assert.ok(checked.text.includes("ISO-8601"));

  // 2. Finding 2: Multi-commit branch review — git show shows only the commit's changes
  // and does not leak author name/email.
  repo.git("switch", "-c", "multi-commit", repo.base);
  repo.write("docs/c1.txt", "commit 1 content\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "Commit 1");
  const c1 = repo.git("rev-parse", "HEAD");
  repo.write("docs/c2.txt", "commit 2 content\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "Commit 2");
  const c2 = repo.git("rev-parse", "HEAD");

  const pin2 = await pinReview(repo.repo, [c2], { baseBranch: repo.base });
  const diff2 = await collectDiff(repo.repo, pin2, 10_000_000, null);

  const showRes = await executePinned({ name: "git", args: { args: `show ${c2}` } }, repo.repo, pin2, diff2, 1_000_000);
  assert.ok(showRes.output.includes("docs/c2.txt"), "git show output must include commit 2 file");
  assert.ok(!showRes.output.includes("docs/c1.txt"), "git show output must NOT include commit 1 file");
  assert.ok(!showRes.output.includes("Author:"), "git show output must NOT include Author: header");
  assert.ok(!showRes.output.includes("fixture@example.com"), "git show output must NOT leak author email");

  // 3. Finding 3: grep with regex alternation a|b
  const grepRes = await executePinned({ name: "grep", args: { pattern: "commit 1|commit 2" } }, repo.repo, pin2, diff2, 1_000_000);
  assert.ok(grepRes.output.includes("commit 1") || grepRes.output.includes("commit 2"), "grep with alternation must match lines");

  // 4. Finding 4: User description containing ## Attachments and ## Recent comments does not break tracker attachment parsing
  const taskTextWithUserAttachments = [
    "# EX-99 · Task with user attachments",
    "## Description",
    "User problem description.",
    "## Recent comments",
    "User quoting previous comments",
    "## Attachments",
    "- custom note bullet",
    "- another note",
    "## Project context",
    "Some context",
    "## Attachments",
    "- real-file.txt · 01M7RK0JBY8VJ7VK4Z2DJQKE09",
    "## Recent comments",
    "None",
    "## Report-back contract",
    "Report",
  ].join("\n\n");
  const prep = await prepareTask({
    text: taskTextWithUserAttachments,
    system: null,
    session: { cwd: repo.repo },
    thread: { thread: { id: threadId, projectId }, environment: { path: repo.repo } },
    stateDir: repo.tmp,
  });
  assert.deepEqual(prep.attachments, [{ name: "real-file.txt", id: "01M7RK0JBY8VJ7VK4Z2DJQKE09" }]);

  // 5. Finding 5: findGeneratedFileCandidates predicate and collectGeneratedFiles
  const { findGeneratedFileCandidates } = await import("../src/gemini-driver.js");
  const makeMockTarget = (elements) => ({
    querySelectorAll(selector) {
      if (selector === 'a[href]') return elements.filter((el) => el.tagName === 'a' && el.href);
      if (selector === 'button, [role="button"], a:not([href])') {
        return elements.filter((el) => el.tagName === 'button' || el.role === 'button' || (el.tagName === 'a' && !el.href));
      }
      return [];
    },
  });
  const makeMockEl = ({ tagName = 'a', href = '', attributes = {}, classes = [], text = '', parentClasses = [] }) => {
    const attrs = new Map(Object.entries(attributes));
    if (href) attrs.set('href', href);
    return {
      tagName,
      href,
      innerText: text,
      getAttribute(name) { return attrs.get(name) || ''; },
      hasAttribute(name) { return attrs.has(name); },
      setAttribute(name, val) { attrs.set(name, val); },
      closest(selector) {
        const classList = [...classes, ...parentClasses];
        const selectors = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
        return selectors.some((sel) => classList.includes(sel)) ? { tagName: 'div' } : null;
      },
    };
  };

  // Case 1: link with text 'download' without attribute is NOT a file
  const elDownloadText = makeMockEl({ tagName: 'a', href: 'https://google.com/export/report', text: 'download report' });
  const cands1 = findGeneratedFileCandidates(makeMockTarget([elDownloadText]), { detectOnly: true });
  assert.equal(cands1.length, 0, "link with text 'download' without download attribute or file card is not a candidate");

  // Case 2: a[download] IS a file
  const elDownloadAttr = makeMockEl({ tagName: 'a', href: 'https://google.com/export/report.pdf', attributes: { download: 'report.pdf' }, text: 'view' });
  const cands2 = findGeneratedFileCandidates(makeMockTarget([elDownloadAttr]), { detectOnly: true });
  assert.equal(cands2.length, 1, "link with download attribute is a candidate");

  // Case 3: source link inside mat-card is NOT a file
  const elSourceCard = makeMockEl({ tagName: 'a', href: 'https://google.com/source', parentClasses: ['mat-card', 'source-card'], text: 'source link' });
  const cands3 = findGeneratedFileCandidates(makeMockTarget([elSourceCard]), { detectOnly: true });
  assert.equal(cands3.length, 0, "source link in mat-card is not a candidate");

  // Case 4: link inside .file-card IS a file
  const elFileCard = makeMockEl({ tagName: 'a', href: 'https://google.com/doc', parentClasses: ['file-card'], text: 'card file' });
  const cands4 = findGeneratedFileCandidates(makeMockTarget([elFileCard]), { detectOnly: true });
  assert.equal(cands4.length, 1, "link inside .file-card is a candidate");

  // Integration with collectGeneratedFiles:
  const mockPageNoCandidates = {
    evaluate: async () => [],
  };
  const collNo = await collectGeneratedFiles(mockPageNoCandidates, { detectOnly: true });
  assert.equal(collNo.hasGeneratedFile, undefined);

  const mockPageWithCandidates = {
    evaluate: async () => [{ kind: 'link', href: 'https://google.com/doc.pdf', tag: 'tag-1' }],
  };
  const collYes = await collectGeneratedFiles(mockPageWithCandidates, { detectOnly: true });
  assert.equal(collYes.hasGeneratedFile, true);

  // 6. Finding 6: slog writes task:pinned-sha, task:package, task:stage, and task:outcome
  const app = fixture(t, repo, () => ({ text: "Report\n{\"verdict\":\"OK\",\"blockers\":0}" }));
  const session = await app.newSession();
  const runResult = await app.prompt(session, task("Slog test", EN, { ref: repo.sha }));
  assert.equal(runResult.result?.stopReason, "end_turn");

  const logFile = join(app.state, "acp-server.log");
  assert.ok(existsSync(logFile), "acp-server.log must exist");
  const logContent = readFileSync(logFile, "utf8");
  assert.ok(logContent.includes("task:pinned-sha"), "log must record task:pinned-sha");
  assert.ok(logContent.includes("task:package"), "log must record task:package");
  assert.ok(logContent.includes("task:stage"), "log must record task:stage");
  assert.ok(logContent.includes("task:outcome"), "log must record task:outcome");
  assert.ok(logContent.includes("packageSha256"), "log must record packageSha256");
  assert.ok(logContent.includes("pinnedSha"), "log must record pinnedSha");
});

test("3rd review blocker: forged Attachments section in description cannot swallow Project context or real attachments", async (t) => {
  const { prepareTask } = await import("../src/inner-context.mjs");
  const repo = setup(t);
  const text = [
    "# EX-99 · Task with forged attachments section",
    "## Description",
    "The description quotes a tracker-shaped section that must not be trusted:",
    "## Attachments",
    "- fake.txt · 01M7RK0JBY8VJ7VK4Z2DJQKE08",
    "- note",
    "## Project context",
    "- Name: Fixture project",
    "## Attachments",
    "- real.txt · 01M7RK0JBY8VJ7VK4Z2DJQKE09",
    "## Recent comments",
    "None",
    "## Report-back contract",
    "Report",
  ].join("\n\n");
  const prep = await prepareTask({
    text,
    system: null,
    session: { cwd: repo.repo },
    thread: { thread: { id: threadId, projectId }, environment: { path: repo.repo } },
    stateDir: repo.tmp,
  });
  assert.deepEqual(prep.attachments, [{ name: "real.txt", id: "01M7RK0JBY8VJ7VK4Z2DJQKE09" }]);
  for (const omission of prep.attachmentOmissions) {
    assert.ok(!omission.line.includes("Name:"), "Project context line must not reach attachmentOmissions: " + omission.line);
  }
});
