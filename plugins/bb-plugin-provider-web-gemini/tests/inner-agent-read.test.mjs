import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
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

const readAnswer = () => ({ text: "Fixture review\n{\"verdict\":\"OK\",\"blockers\":0}" });
const toolCall = (id, name, args) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});
const toolReply = (...tool_calls) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls } }] });
const agentDone = { choices: [{ message: { role: "assistant", content: "AGENT-FREE-FORM" } }] };

async function gateway(t, respond, tls) {
  const requests = [];
  const handle = async (req, res) => {
    try {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const payload = JSON.parse(Buffer.concat(body).toString());
      requests.push({ url: req.url, method: req.method, headers: req.headers, payload });
      const result = respond(requests.length, req);
      if (result === undefined) return;
      res.writeHead(result.status ?? 200, { "Content-Type": "application/json", ...result.headers });
      res.end(result.raw ?? JSON.stringify(result));
    } catch (error) {
      res.writeHead(500);
      res.end();
      requests.push({ error });
    }
  };
  const listener = tls ? httpsServer(tls, handle) : httpServer(handle);
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => new Promise((resolve) => {
    listener.close(resolve);
    listener.closeAllConnections();
  }));
  return { requests, baseUrl: (tls ? "https" : "http") + "://127.0.0.1:" + listener.address().port + "/compat/v1/" };
}

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
  const { BB_THREAD_ID: _inheritedThread, ...inheritedEnv } = process.env;
  const launchArgs = [entry, "--session-access=read-only"];
  // options.bindEnv — привязка через env BB_THREAD_ID, канал customAgents
  // provider-acp со статическим argv (без --bb-thread-id).
  if (!options.bindEnv) launchArgs.push("--bb-thread-id=" + threadId);
  const { messages, send, notify } = rpcProcess(t, launchArgs, {
    ...inheritedEnv,
    BB_CLI: cli, WEB_GEMINI_FAKE: "0", ARGON_FAKE: "0",
    WEB_GEMINI_STATE_DIR: state, WEB_GEMINI_POOL_FILE: join(dir, "absent"),
    WEB_GEMINI_BACKENDS: JSON.stringify([{ id: "web-fixture", cdp: 19223, profileDir: dir, tier: "pro" }]),
    WEB_GEMINI_SESSION_CAP_MS: "120000",
    ...(options.bindEnv ? { BB_THREAD_ID: threadId } : {}),
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
  for (const item of [...manifest.included, ...(manifest.supplements ?? [])]) {
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

test("fast agent reads a pinned snapshot through four tools and appends a masked, signed supplement", async (t) => {
  const repo = setup(t);
  const outside = join(repo.tmp, "outside.txt");
  writeFileSync(outside, "OUTSIDE-SNAPSHOT");
  repo.git("switch", "review");
  symlinkSync(outside, join(repo.repo, "docs", "outward.txt"));
  repo.git("add", "docs/outward.txt");
  repo.git("commit", "-m", "Add outward symlink fixture");
  const sha = repo.git("rev-parse", "HEAD");
  repo.git("switch", "main");
  const prompt = task("Review this revision. Task marker ZX67-marker.", EN, { ref: sha });
  const commonSettings = { context: { maskPatterns: { [projectId]: [{ type: "project", pattern: "ZX[0-9]+-marker" }] } } };
  const off = fixture(t, repo, readAnswer, { settings: commonSettings });
  assert.equal((await off.prompt(await off.newSession(), prompt)).result?.stopReason, "end_turn");
  const baseline = delivered(off.requests()[0]);
  assert.equal(baseline.manifest.supplements, undefined);

  const certFile = join(repo.tmp, "cert.pem");
  const keyFile = join(repo.tmp, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  const mock = await gateway(t, (n) => {
    if (n !== 1) return agentDone;
    repo.git("update-ref", "refs/heads/review", repo.head);
    return toolReply(
      toolCall("read", "read_file", { path: "docs/notes.txt", from: 1, to: 2 }),
      toolCall("list", "list_dir", { path: "docs" }),
      toolCall("grep", "grep", { pattern: "ZX12-marker" }),
      toolCall("git", "git", { args: "diff --stat" }),
      toolCall("ancestor", "git", { args: "show HEAD~2:docs/notes.txt" }),
      toolCall("unrelated", "git", { args: "show " + repo.head + ":docs/notes.txt" }),
      toolCall("blame", "git", { args: "blame docs/notes.txt" }),
      toolCall("symlink_diff", "git", { args: "show HEAD -- docs/outward.txt" }),
      toolCall("outside", "read_file", { path: "../outside.txt" }),
      toolCall("absolute", "read_file", { path: outside }),
      toolCall("symlink", "read_file", { path: "docs/outward.txt" }),
      toolCall("private", "read_file", { path: "private/.env.review" }),
      toolCall("git_dir", "list_dir", { path: ".git" }),
      toolCall("git_write", "git", { args: "config --list" }),
      toolCall("extra_arg", "read_file", { path: "docs/notes.txt", shell: true }),
    );
  }, { cert: readFileSync(certFile), key: readFileSync(keyFile) });
  const auth = "fixture-gateway-credential";
  const on = fixture(t, repo, readAnswer, {
    settings: { ...commonSettings, innerAgent: { enabled: true, gateway: { model: "fixture-fast", baseUrl: mock.baseUrl, tokenEnv: "FIXTURE_AGENT_TOKEN" } } },
    env: { NODE_EXTRA_CA_CERTS: certFile, FIXTURE_AGENT_TOKEN: auth },
  });
  assert.equal((await on.prompt(await on.newSession(), prompt)).result?.stopReason, "end_turn");
  assert.equal(mock.requests.length, 2);
  const [{ payload, url, method, headers }, second] = mock.requests;
  assert.equal(url, "/compat/v1/chat/completions");
  assert.equal(method, "POST");
  assert.equal(headers.authorization, "Bearer " + auth);
  assert.equal(payload.stream, false);
  assert.equal(payload.model, "fixture-fast");
  assert.deepEqual(payload.tools.map((entry) => entry.function.name), ["read_file", "list_dir", "grep", "git"]);
  assert.ok(payload.tools.every((entry) => entry.function.parameters.additionalProperties === false));
  assert.deepEqual(payload.tools[0].function.parameters.properties.from, { type: "integer", minimum: 1 });
  assert.match(payload.messages[1].content, /Core inventory.*review value/s);
  const tools = new Map(second.payload.messages.filter((entry) => entry.role === "tool").map((entry) => [entry.tool_call_id, entry.content]));
  assert.equal(tools.size, 15);
  assert.match(tools.get("read"), /review value\n\[скрыто: project\]/);
  assert.match(tools.get("list"), /docs\/review-only\.txt/);
  assert.match(tools.get("grep"), /\[скрыто: project\]/);
  assert.match(tools.get("git"), /docs\/notes.txt/);
  const exclusions = JSON.parse(tools.get("git").split("\n", 1)[0]).excluded;
  for (const entry of [
    { source: "Git diff", reason: "sensitive paths (1)" },
    { source: "package-lock.json", reason: "lock file" },
    { source: "nested/dist/artifact.txt", reason: "generated/dependency tree" },
    { source: "picture.bin", reason: "binary, stat only" },
    { source: "forced.bin", reason: "binary, stat only" },
  ]) assert.ok(exclusions.some((item) => item.source === entry.source && item.reason === entry.reason));
  assert.equal(tools.get("ancestor"), "base value\n");
  assert.match(tools.get("blame"), /review value/);
  assert.doesNotMatch(tools.get("symlink_diff"), /docs\/outward\.txt|outside\.txt|\/tmp/);
  for (const id of ["outside", "absolute", "symlink", "private", "git_dir", "git_write", "extra_arg", "unrelated"]) {
    assert.match(tools.get(id), /^error:/);
  }
  const actual = delivered(on.requests()[0]);
  assert.equal(actual.manifest.coreSha256, baseline.manifest.coreSha256);
  assert.deepEqual(actual.manifest.included, baseline.manifest.included);
  assert.ok(actual.content.includes("=== Дополнения быстрого агента / Fast agent additions ==="));
  const [read] = actual.manifest.supplements;
  assert.equal(read.source, "добавил быстрый агент: docs/notes.txt");
  assert.match(read.reason, /requested file text/);
  assert.equal(read.revision, sha);
  assert.deepEqual(read.sourceRange, { fromLine: 1, toLine: 2, totalLines: 3 });
  assert.equal(read.included, "partial");
  const diff = actual.manifest.supplements.find((entry) => entry.tool === "git");
  assert.deepEqual(diff.revisionRange, [repo.base, sha]);
  assert.deepEqual(diff.excluded, exclusions);
  assert.equal(diff.included, "partial");
  assert.equal(actual.manifest.supplements.find((entry) => entry.source.includes("HEAD~2")).revision, repo.base);
  assert.deepEqual(actual.manifest.omitted.find((entry) => entry.source === read.source).missingRanges, [{ fromLine: 3, toLine: 3 }]);
  assert.ok(actual.manifest.omitted.some((entry) => entry.reason.includes("read denied")));
  assert.doesNotMatch(JSON.stringify([payload, second.payload]) + actual.content,
    /ZX(?:12|67)-marker|different HEAD|OUTSIDE-SNAPSHOT|HIDDEN PATH CONTENT|AGENT-FREE-FORM|fixture-gateway-credential/);
  const updates = on.messages.map((message) => message.params?.update).filter(Boolean);
  const fast = updates.filter((update) => update.sessionUpdate === "tool_call" && update.title.startsWith("Fast agent"));
  assert.equal(fast.length, 15);
  for (const call of fast) assert.ok(updates.some((update) => update.sessionUpdate === "tool_call_update" &&
    update.toolCallId === call.toolCallId && ["completed", "failed"].includes(update.status)));
  assert.ok(updates.some((update) => update.content?.[0]?.content?.text?.includes("fast_agent_gateway")));
});

test("pinned tools return session-relative paths that can be passed back to read_file", async (t) => {
  const repo = setup(t);
  const cwd = join(repo.repo, "docs");
  const mock = await gateway(t, (n) => {
    if (n === 1) return toolReply(
      toolCall("list", "list_dir", {}),
      toolCall("grep", "grep", { pattern: "review value match" }),
      toolCall("indexed", "git", { args: "ls-files" }),
      toolCall("deleted", "git", { args: "ls-files --deleted" }),
      toolCall("status", "git", { args: "status" }),
      toolCall("show", "git", { args: "show HEAD -- notes.txt" }),
      toolCall("diff", "git", { args: "diff -- notes.txt" }),
    );
    if (n === 2) {
      const list = mock.requests[1].payload.messages.find((entry) => entry.tool_call_id === "list");
      const file = list.content.split("\n").find((row) => row.endsWith("review-only.txt"));
      return toolReply(toolCall("roundtrip", "read_file", { path: file }));
    }
    return agentDone;
  });
  const acp = fixture(t, { ...repo, repo: cwd }, readAnswer, {
    settings: { innerAgent: { enabled: true, model: "fixture-fast", gateway: { baseUrl: mock.baseUrl } } },
  });
  assert.equal((await acp.prompt(await acp.newSession(), task("Find relevant review material.", EN, { ref: repo.sha })))
    .result?.stopReason, "end_turn");
  assert.equal(mock.requests.length, 3);
  const tools = new Map(mock.requests[1].payload.messages.filter((entry) => entry.role === "tool")
    .map((entry) => [entry.tool_call_id, entry.content]));
  assert.match(tools.get("list"), /(?:^|\n)review-only\.txt(?:\n|$)/);
  assert.match(tools.get("grep"), /^"review-only\.txt":1:review value match$/);
  assert.match(tools.get("indexed"), /(?:^|\n)review-only\.txt(?:\n|$)/);
  assert.match(tools.get("deleted"), /^error:/);
  assert.match(tools.get("status"), /(?:^|\n) notes\.txt\s+\|/);
  const statusExclusions = [{ source: "symlink.txt", reason: "symlink or submodule" }];
  assert.deepEqual(JSON.parse(tools.get("status").split("\n", 1)[0]).excluded, statusExclusions);
  for (const name of ["diff", "show"]) assert.match(tools.get(name), /diff --git a\/notes\.txt b\/notes\.txt/);
  assert.doesNotMatch([...tools.values()].join("\n"), /docs\/|different HEAD/);
  const actual = delivered(acp.requests()[0]);
  assert.equal(actual.materials.get("добавил быстрый агент: review-only.txt"), "review value match\n");
  assert.deepEqual(actual.manifest.supplements.find((entry) => entry.source === "добавил быстрый агент: status").excluded, statusExclusions);
});

test("ordinary tasks read a local shallow clone without remotes, isolated from the working tree", async (t) => {
  const repo = setup(t);
  for (let n = 0; n < 51; n++) repo.git("commit", "--allow-empty", "-qm", "Local history " + n);
  const checkout = join(repo.tmp, "worktree");
  repo.git("worktree", "add", "--detach", checkout);
  const cwd = join(checkout, "docs");
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  const sandboxParent = join(repo.tmp, "sandboxes");
  mkdirSync(sandboxParent);
  writeFileSync(join(cwd, "notes.txt"), "staged text\n");
  git("add", "docs/notes.txt");
  writeFileSync(join(cwd, "notes.txt"), "working text\n");
  writeFileSync(join(cwd, "new.txt"), "untracked text\n");
  writeFileSync(join(checkout, "outside-cwd.txt"), "ROOT-ONLY");
  symlinkSync("../outside-cwd.txt", join(cwd, "escape.txt"));
  let snapshot;
  const mock = await gateway(t, (n) => {
    if (n !== 1) return agentDone;
    const [dir] = readdirSync(sandboxParent);
    const snapshotRoot = join(sandboxParent, dir, "repo");
    const snapshotGit = (...args) => execFileSync("git", args, { cwd: snapshotRoot, encoding: "utf8" }).trim();
    snapshot = [statSync(join(snapshotRoot, ".git")).isDirectory(), snapshotGit("rev-parse", "--is-shallow-repository"), snapshotGit("remote")];
    writeFileSync(join(cwd, "notes.txt"), "LATE-MUTATION");
    return toolReply(
      toolCall("dirty", "read_file", { path: "notes.txt" }),
      toolCall("untracked", "read_file", { path: "new.txt" }),
      toolCall("grep", "grep", { pattern: "untracked text" }),
      toolCall("list", "list_dir", {}),
      toolCall("indexed", "git", { args: "ls-files" }),
      toolCall("staged", "git", { args: "diff --cached" }),
      toolCall("status", "git", { args: "status" }),
      toolCall("log", "git", { args: "log -50" }),
      toolCall("blame", "git", { args: "blame notes.txt" }),
      toolCall("boundary", "git", { args: "show HEAD~49" }),
      toolCall("beyond_boundary", "git", { args: "show HEAD~50" }),
      toolCall("no_escape", "read_file", { path: "escape.txt" }),
      toolCall("no_root", "git", { args: "show HEAD:../outside-cwd.txt" }),
    );
  });
  const acp = fixture(t, { ...repo, repo: cwd }, readAnswer, {
    settings: { innerAgent: { enabled: true, model: "fixture-fast", gateway: { baseUrl: mock.baseUrl } } },
    env: { TMPDIR: sandboxParent },
  });
  const response = await acp.prompt(await acp.newSession(), task("Read the current working context.", EN));
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response));
  assert.deepEqual(snapshot, [true, "true", ""]);
  assert.deepEqual(readdirSync(sandboxParent), []);
  assert.match(git("status", "--short"), /MM docs\/notes.txt/);
  const actual = delivered(acp.requests()[0]);
  assert.equal(actual.materials.get("добавил быстрый агент: notes.txt"), "working text\n");
  assert.equal(actual.materials.get("добавил быстрый агент: new.txt"), "untracked text\n");
  assert.equal(actual.materials.get("добавил быстрый агент: grep"),
    '"new.txt":1:untracked text\n(1 paths omitted from the working snapshot)');
  assert.match(actual.materials.get("добавил быстрый агент: list_dir"), /(?:^|\n)new\.txt(?:\n|$)/);
  assert.match(actual.materials.get("добавил быстрый агент: ls-files"), /^notes\.txt$/m);
  assert.match(actual.materials.get("добавил быстрый агент: diff --cached"), /\+staged text/);
  assert.match(actual.materials.get("добавил быстрый агент: diff --cached"), /diff --git a\/notes\.txt b\/notes\.txt/);
  assert.match(actual.materials.get("добавил быстрый агент: status"), /^MM "notes\.txt"$/m);
  const missingRanges = [{ beforeCommit: git("rev-parse", "HEAD~49") }];
  for (const args of ["log -50", "blame notes.txt", "show HEAD~49"]) {
    const source = "добавил быстрый агент: " + args;
    assert.equal(actual.manifest.supplements.find((item) => item.source === source)?.included, "partial");
    assert.deepEqual(actual.manifest.omitted.find((item) => item.source === source)?.missingRanges, missingRanges);
    assert.match(actual.materials.get(source), /History limited by the shallow snapshot/);
  }
  assert.doesNotMatch(actual.materials.get("добавил быстрый агент: show HEAD~49"), /diff --git/);
  assert.deepEqual(actual.manifest.omitted.find((item) => item.source === "Git snapshot history")?.missingRanges, missingRanges);
  const beyond = mock.requests[1].payload.messages.find((entry) => entry.tool_call_id === "beyond_boundary");
  assert.match(beyond.content, /^error:/);
  assert.doesNotMatch(JSON.stringify(mock.requests) + actual.content, /ROOT-ONLY|LATE-MUTATION/);
});

test("working snapshot inventories skipped files and reports sensitive status as a count", async (t) => {
  const repo = setup(t);
  const cwd = join(repo.repo, "docs");
  const maxTotalBytes = 24_000;
  repo.write("docs/.env.clean-fixture", "HIDDEN-CLEAN-FIXTURE\n");
  repo.write("docs/.env.changed-fixture", "HIDDEN-INITIAL-FIXTURE\n");
  repo.write("docs/.env.deleted-fixture", "HIDDEN-DELETED-FIXTURE\n");
  repo.write("docs/disappeared.txt", "deleted file fixture\n");
  repo.write("docs/gone/only.txt", "deleted nested fixture\n");
  repo.write(".gitattributes", "docs/too-large.txt -diff\n");
  repo.write("docs/too-large.txt", "small before modification\n");
  repo.write("docs/intact/visible.txt", "visible intact fixture\n");
  symlinkSync("notes.txt", join(cwd, "tracked-link.txt"));
  repo.git("add", ".");
  repo.git("commit", "-qm", "Files for the working snapshot");
  repo.write("docs/.env.changed-fixture", "HIDDEN-CHANGED-FIXTURE\n");
  repo.write("docs/.env.untracked-fixture", "HIDDEN-UNTRACKED-FIXTURE\n");
  repo.write("docs/too-large.txt", "x".repeat(maxTotalBytes + 1));
  repo.write("docs/at-limit.txt", "x".repeat(maxTotalBytes));
  repo.write("docs/notes.txt", "visible worktree change\n");
  rmSync(join(cwd, "disappeared.txt"));
  rmSync(join(cwd, "gone", "only.txt"));
  rmSync(join(cwd, ".env.deleted-fixture"));
  symlinkSync("notes.txt", join(cwd, "ZX41-marker.txt"));

  const sandboxParent = join(repo.tmp, "sandboxes");
  mkdirSync(sandboxParent);
  const sandboxAlias = join(repo.tmp, "sandboxes-alias");
  symlinkSync(sandboxParent, sandboxAlias);
  let snapshotFiles;
  const mock = await gateway(t, (n) => {
    if (n !== 1) return agentDone;
    const [dir] = readdirSync(sandboxParent);
    snapshotFiles = readdirSync(join(sandboxParent, dir, "repo", "docs"));
    return toolReply(
      toolCall("status", "git", { args: "status" }),
      toolCall("worktree", "git", { args: "diff" }),
      toolCall("list", "list_dir", {}),
      toolCall("grep", "grep", { pattern: "visible" }),
      toolCall("gone", "list_dir", { path: "gone" }),
      toolCall("intact", "grep", { pattern: "visible", path: "intact" }),
      toolCall("indexed", "git", { args: "ls-files" }),
      toolCall("deleted", "git", { args: "ls-files --deleted" }),
      toolCall("deleted_scoped", "git", { args: "ls-files --deleted -- gone" }),
      toolCall("large", "read_file", { path: "too-large.txt" }),
    );
  });
  const acp = fixture(t, { ...repo, repo: cwd }, (request) => request.count === 1
    ? { text: '<tool name="git" args="ls-files --deleted"/>' } : { text: 'Reviewed\n{"verdict":"OK","blockers":0}' }, {
    settings: {
      context: { maxTotalBytes, maskPatterns: { [projectId]: [{ type: "project", pattern: "ZX[0-9]+-marker" }] } },
      innerAgent: { enabled: true, model: "fixture-fast", gateway: { baseUrl: mock.baseUrl } },
    },
    env: { TMPDIR: sandboxAlias },
  });
  const response = await acp.prompt(await acp.newSession(), task("Read current status.", EN));
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));
  assert.deepEqual(snapshotFiles, ["at-limit.txt", "base-only.txt", "intact", "notes.txt"]);
  assert.deepEqual(readdirSync(sandboxParent), []);
  const tools = new Map(mock.requests[1].payload.messages.filter((entry) => entry.role === "tool")
    .map((entry) => [entry.tool_call_id, entry.content]));
  assert.match(tools.get("status"), /^ M "notes\.txt"$/m);
  assert.match(tools.get("status"), /\(3 sensitive paths hidden\)/);
  assert.match(tools.get("status"), /\(5 paths omitted from the working snapshot\)/);
  assert.match(tools.get("worktree"), /\+visible worktree change/);
  assert.match(tools.get("worktree"), /\(5 paths omitted from the working snapshot\)/);
  assert.match(tools.get("list"), /at-limit\.txt/);
  assert.match(tools.get("grep"), /"notes\.txt":1:visible worktree change/);
  for (const name of ["list", "grep"]) assert.match(tools.get(name), /\(5 paths omitted from the working snapshot\)/);
  assert.match(tools.get("gone"), /\(1 paths omitted from the working snapshot\)/);
  assert.equal(tools.get("intact"), '"intact/visible.txt":1:visible intact fixture');
  assert.equal(tools.get("deleted"), "disappeared.txt\ngone/only.txt");
  assert.equal(tools.get("deleted_scoped"), "gone/only.txt");
  assert.match(tools.get("large"), /^error:/);
  for (const name of ["status", "worktree", "list", "indexed"]) {
    assert.doesNotMatch(tools.get(name), /disappeared\.txt|tracked-link\.txt|too-large\.txt/);
  }
  const [first, followUp] = acp.requests();
  const actual = delivered(first);
  const followUpText = followUp.files[0]?.text ?? followUp.prompt;
  assert.match(followUpText, /^docs\/disappeared\.txt\ndocs\/gone\/only\.txt$/m);
  assert.doesNotMatch(followUpText, /\.env\.deleted-fixture|too-large\.txt|tracked-link\.txt/);
  assert.equal(actual.materials.get("добавил быстрый агент: status"), tools.get("status"));
  for (const [source, included] of [["diff", "partial"], ["list_dir", "partial"], ["grep", "partial"], ["gone", "partial"], ["intact", "full"]]) {
    assert.equal(actual.manifest.supplements.find((item) => item.source === "добавил быстрый агент: " + source)?.included, included);
  }
  for (const [source, reason] of [
    ["too-large.txt", "file exceeds working snapshot byte limit"],
    ["disappeared.txt", "path missing from working snapshot"],
    ["tracked-link.txt", "not a regular file in working snapshot"],
    ["[скрыто: project].txt", "not a regular file in working snapshot"],
  ]) {
    assert.ok(actual.manifest.omitted.some((entry) => entry.source === source && entry.reason === reason), source);
  }
  assert.doesNotMatch(JSON.stringify(mock.requests) + actual.content, /\.env\..*-fixture|HIDDEN-.*-FIXTURE|ZX41-marker/);
});

test("fast agent failure, redirect and timeout preserve core and verified reads", async (t) => {
  for (const [name, reply, reason] of [
    ["malformed", { raw: "invalid JSON" }, /invalid gateway response/],
    ["duplicate", toolReply(toolCall("read", "list_dir", {})), /invalid or duplicate gateway tool call/],
    ["redirect", { status: 307, headers: { Location: "/untrusted" } }, /HTTP 307/],
    ["timeout", undefined, /fast agent timed out/],
  ]) await t.test(name, async (t) => {
    const repo = setup(t);
    const mock = await gateway(t, (n) => n === 1 ? toolReply(toolCall("read", "read_file", { path: "docs/review-only.txt" })) : reply);
    const acp = fixture(t, repo, readAnswer, { settings: { innerAgent: {
      enabled: true, timeoutMs: 1200, gateway: { baseUrl: mock.baseUrl, model: "fixture-fast" },
    } } });
    assert.equal((await acp.prompt(await acp.newSession(), task("Read failure case.", EN, { ref: repo.sha }))).result?.stopReason, "end_turn");
    assert.equal(mock.requests.length, 2);
    const actual = delivered(acp.requests()[0]);
    assert.equal(actual.materials.get("добавил быстрый агент: docs/review-only.txt"), "review value match\n");
    assert.ok(actual.manifest.omitted.some((entry) => reason.test(entry.reason)));
  });
});

test("fast agent stops at call, round and byte limits and preserves core during delivery overflow", async (t) => {
  const repo = setup(t);
  const prompt = task("Read with limited enrichment.", EN, { ref: repo.sha });
  const baseline = fixture(t, repo, readAnswer);
  assert.equal((await baseline.prompt(await baseline.newSession(), prompt)).result?.stopReason, "end_turn");
  const request = baseline.requests()[0];
  const bytes = Buffer.byteLength(request.prompt) + request.files.reduce((sum, file) => sum + Buffer.from(file.data, "base64").length, 0);
  const core = delivered(request).manifest.coreSha256;
  for (const [name, limits, reason] of [
    ["calls", { maxCalls: 1 }, /tool call limit reached/],
    ["rounds", { maxRounds: 1 }, /round limit reached/],
    ["bytes", { maxBytes: 64 }, /additional byte limit reached/],
    ["delivery", {}, /delivery budget excluded/],
    ["full-core", {}, /no delivery budget/],
  ]) await t.test(name, async (t) => {
    const long = ["bytes", "delivery"].includes(name);
    const mock = await gateway(t, () => toolReply(
      toolCall("read", "read_file", { path: long ? "docs/long.txt" : "docs/review-only.txt" }),
      toolCall("list", "list_dir", {}),
    ));
    const acp = fixture(t, repo, readAnswer, { settings: {
      innerAgent: { enabled: true, gateway: { baseUrl: mock.baseUrl, model: "fixture-fast" }, ...limits },
      ...(name === "delivery" ? { context: { maxTotalBytes: bytes + 540 } } : {}),
      ...(name === "full-core" ? { context: { maxTotalBytes: bytes } } : {}),
    } });
    assert.equal((await acp.prompt(await acp.newSession(), prompt)).result?.stopReason, "end_turn");
    assert.equal(mock.requests.length, name === "full-core" ? 0 : 1);
    const actual = delivered(acp.requests()[0]);
    assert.equal(actual.manifest.coreSha256, core);
    assert.ok(actual.manifest.omitted.some((entry) => reason.test(entry.reason)), JSON.stringify(actual.manifest.omitted));
    if (name === "calls") assert.equal(actual.manifest.supplements.length, 1);
    if (name === "rounds") assert.equal(actual.manifest.supplements.length, 2);
    if (name === "bytes") {
      const [item] = actual.manifest.supplements;
      assert.equal(item.included, "partial");
      assert.ok(item.bytes <= 64 && item.truncated.totalBytes > item.bytes);
    }
    if (["delivery", "full-core"].includes(name)) assert.equal(actual.manifest.supplements, undefined);
  });
});

test("invalid fast-agent transport settings fail before gateway or web delivery", async (t) => {
  const repo = setup(t);
  const credentialUrl = ["https://user:secret", "example.invalid/v1"].join("@");
  for (const baseUrl of ["http://example.invalid/v1", "http://127.1/v1", credentialUrl]) {
    const acp = fixture(t, repo, readAnswer, {
      settings: { innerAgent: { enabled: true, gateway: { baseUrl, model: "fixture-fast" } } },
    });
    const response = await acp.prompt(await acp.newSession(), task("Read transport check.", EN));
    assert.equal(response.error?.data?.outcome, "not_started");
    assert.match(response.error.message, /gateway/);
    assert.doesNotMatch(response.error.message, /secret/);
    assert.deepEqual(acp.requests(), []);
  }
});

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
        '<tool name="git" args="status"/>',
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
    const diffResults = [...results.matchAll(/^=== tool: git ===\n(\{.*\})$/gm)].map(([, json]) => JSON.parse(json));
    for (const source of ["diff --stat", "status"]) {
      const result = diffResults.find((entry) => entry.source === `args="${source}"`);
      assert.equal(result?.partial, true);
      assert.ok(result.excluded.some((entry) => entry.source === "picture.bin" && entry.reason === "binary, stat only"));
      assert.ok(result.excluded.some((entry) => entry.source === "Git diff" && entry.reason === "sensitive paths (1)"));
    }
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
  const repo = setup(t);
  const fragments = [
    "gh" + "p_" + "x".repeat(16), "qa" + "@gma" + "il.com", "/" + "home/" + "fake" + "/test",
    ["192", "168", "45", "67"].join("."), threadId, projectId, key, hostname(),
  ].filter((value) => value.length > 2);
  const text = fragments.join("\n");
  // Паритет с правилами пакетов оркестратора проверяется напрямую по outbound
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

test("delegate packet's multi-line Attachments entry parses into context.attachments (PLUG-353)", async (t) => {
  const { prepareTask } = await import("../src/inner-context.mjs");
  const repo = setup(t);
  const text = [
    "# PLUG-352 · Delegate packet fixture",
    "## Description",
    "Inspect the attachment",
    "## Project context",
    "- Name: Fixture project\n- Linked bb project: " + projectId,
    "## Sub-tasks",
    "None.",
    "## Attachments",
    "- audit-prompt.txt · 01M7RK0JBY8VJ7VK4Z2DJQKE09\n  Fetch with: bb tasks attachment get 01M7RK0JBY8VJ7VK4Z2DJQKE09 --out <path>",
    "## Recent comments",
    "None.",
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
  assert.equal(prep.key, "PLUG-352");
  assert.deepEqual(prep.attachments, [{ name: "audit-prompt.txt", id: "01M7RK0JBY8VJ7VK4Z2DJQKE09" }]);
  assert.deepEqual(prep.attachmentOmissions, []);
});

test("BB_THREAD_ID env binding (customAgents launch) runs the task pipeline and materializes tracker attachments (PLUG-353)", async (t) => {
  const repo = setup(t);
  const app = fixture(t, repo, () => ({ text: "Attachment read" }), { bindEnv: true });
  const session = await app.newSession();
  const response = await app.prompt(session, task("Inspect the attachment", EN, { tracker: true }));
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));
  const request = app.requests()[0];
  assert.equal(request.strict, true, "env-bound task turns keep the full-delivery contract");
  const actual = delivered(request);
  const material = actual.manifest.included.find((item) => item.source === "Tracker attachment");
  assert.ok(material, "tracker attachment must be a delivered material");
  assert.equal(material.name, "tracker.md");
  assert.equal(actual.materials.get("tracker.md"), "Tracker input ZX12-marker\n");
  const log = readFileSync(join(app.state, "acp-server.log"), "utf8");
  assert.ok(log.includes("task:package"), "env-bound launches must run the task pipeline");
});

test("argv --bb-thread-id wins over env BB_THREAD_ID (PLUG-353)", async (t) => {
  const repo = setup(t);
  // env задан другим валидным id: если бы env победил argv, привязка не
  // прошла бы верификацию (fixture CLI знает только threadId) и ход
  // отказал бы на preflight.
  const app = fixture(t, repo, () => ({ text: "Attachment read" }), {
    env: { BB_THREAD_ID: "t" + "hr_envshadow1" },
  });
  const session = await app.newSession();
  const response = await app.prompt(session, task("Inspect the attachment", EN, { tracker: true }));
  assert.equal(response.result?.stopReason, "end_turn", JSON.stringify(response.error));
  const request = app.requests()[0];
  const actual = delivered(request);
  const material = actual.manifest.included.find((item) => item.source === "Tracker attachment");
  assert.ok(material, "argv-bound launch must run the task pipeline");
  const log = readFileSync(join(app.state, "acp-server.log"), "utf8");
  assert.ok(log.includes("task:package"), "argv must take priority over env binding");
});

test("env BB_THREAD_ID that fails verification refuses task turns explicitly (PLUG-353)", async (t) => {
  for (const bad of ["bogus-not-a-thread", "t" + "hr_unresolvable1"]) {
    const repo = setup(t);
    const app = fixture(t, repo, () => ({ text: "unused" }), {
      bindEnv: true,
      env: { BB_THREAD_ID: bad },
    });
    const session = await app.newSession();
    const response = await app.prompt(session, task("Inspect the attachment", EN, { tracker: true }));
    assert.equal(response.result, undefined, "env id " + bad + " must not silently fall back to chat");
    assert.equal(response.error?.data?.outcome, "not_started");
    assert.match(response.error?.message ?? "", /could not verify trusted BB thread metadata/);
    assert.equal(app.requests().length, 0, "refused turn must not reach the web driver");
    const log = readFileSync(join(app.state, "acp-server.log"), "utf8");
    assert.ok(log.includes("task:error"), "refusal must be logged for env id " + bad);
  }
});

test("innerAgent.gateways: 503 failover to second gateway continues enrichment and logs answered element (PLUG-364 a)", async (t) => {
  const repo = setup(t);
  const gw1 = await gateway(t, () => ({ status: 503, raw: "Gateway Unavailable" }));
  const gw2 = await gateway(t, (n) => n === 1
    ? toolReply(toolCall("read", "read_file", { path: "docs/review-only.txt" }))
    : agentDone);
  const acp = fixture(t, repo, readAnswer, {
    settings: {
      innerAgent: {
        enabled: true,
        gateways: [
          { baseUrl: gw1.baseUrl, model: "fast-gw1" },
          { baseUrl: gw2.baseUrl, model: "fast-gw2" },
        ],
      },
    },
  });
  const session = await acp.newSession();
  const res = await acp.prompt(session, task("Read failover test.", EN, { ref: repo.sha }));
  assert.equal(res.result?.stopReason, "end_turn");
  assert.ok(gw1.requests.length >= 1, "first gateway received request");
  assert.ok(gw2.requests.length >= 1, "second gateway received failover request");
  const actual = delivered(acp.requests()[0]);
  assert.equal(actual.materials.get("добавил быстрый агент: docs/review-only.txt"), "review value match\n");
  const log = readFileSync(join(acp.state, "acp-server.log"), "utf8");
  assert.ok(log.includes("gateway[1]"), "log records answered element gateway[1]");
  assert.ok(log.includes("fast_agent_failover"), "log records fast_agent_failover stage");
});

test("innerAgent.gateways: all elements fail writes omitted with failure codes and preserves core (PLUG-364 b)", async (t) => {
  const repo = setup(t);
  const prompt = task("Read all fail test.", EN, { ref: repo.sha });
  const baseline = fixture(t, repo, readAnswer);
  const baseRes = await baseline.prompt(await baseline.newSession(), prompt);
  assert.equal(baseRes.result?.stopReason, "end_turn");
  const expectedCoreSha256 = delivered(baseline.requests()[0]).manifest.coreSha256;

  const gw1 = await gateway(t, () => ({ status: 503 }));
  const gw2 = await gateway(t, () => undefined); // timeout
  const acp = fixture(t, repo, readAnswer, {
    settings: {
      innerAgent: {
        enabled: true,
        timeoutMs: 3000,
        gateways: [
          { baseUrl: gw1.baseUrl, model: "fast-gw1" },
          { baseUrl: gw2.baseUrl, model: "fast-gw2", timeoutMs: 50 },
        ],
      },
    },
  });
  const session = await acp.newSession();
  const res = await acp.prompt(session, prompt);
  assert.equal(res.result?.stopReason, "end_turn");
  const actual = delivered(acp.requests()[0]);
  assert.equal(actual.manifest.coreSha256, expectedCoreSha256, "mandatory core must be preserved");
  const omittedEntry = actual.manifest.omitted.find((item) => item.source === "Fast agent");
  assert.ok(omittedEntry, "Fast agent must have omitted entry");
  assert.equal(omittedEntry.reason, "gateway[0] 503, gateway[1] timeout");
});

test("innerAgent.gateways: 400 and schema errors stop without failover (PLUG-364 c)", async (t) => {
  const repo = setup(t);
  const prompt = task("Read 400 and schema test.", EN, { ref: repo.sha });
  const baseline = fixture(t, repo, readAnswer);
  await baseline.prompt(await baseline.newSession(), prompt);
  const expectedCore = delivered(baseline.requests()[0]).manifest.coreSha256;

  // Case 1: HTTP 400 client error
  const gw1 = await gateway(t, () => ({ status: 400, raw: "Bad Request" }));
  const gw2 = await gateway(t, () => toolReply(toolCall("read", "read_file", { path: "docs/review-only.txt" })));
  const acp1 = fixture(t, repo, readAnswer, {
    settings: {
      innerAgent: {
        enabled: true,
        gateways: [
          { baseUrl: gw1.baseUrl, model: "fast-gw1" },
          { baseUrl: gw2.baseUrl, model: "fast-gw2" },
        ],
      },
    },
  });
  const res1 = await acp1.prompt(await acp1.newSession(), prompt);
  assert.equal(res1.result?.stopReason, "end_turn");
  assert.equal(gw1.requests.length, 1, "gw1 called once");
  assert.equal(gw2.requests.length, 0, "gw2 must not be called on 400");
  const actual1 = delivered(acp1.requests()[0]);
  assert.equal(actual1.manifest.coreSha256, expectedCore, "core preserved");
  assert.ok(actual1.manifest.omitted.some((item) => /HTTP 400/.test(item.reason)));

  // Case 2: schema error (invalid JSON)
  const gwSchema = await gateway(t, () => ({ raw: "not json at all" }));
  const gwUnreached = await gateway(t, () => toolReply(toolCall("read", "read_file", { path: "docs/review-only.txt" })));
  const acp2 = fixture(t, repo, readAnswer, {
    settings: {
      innerAgent: {
        enabled: true,
        gateways: [
          { baseUrl: gwSchema.baseUrl, model: "fast-schema" },
          { baseUrl: gwUnreached.baseUrl, model: "fast-unreached" },
        ],
      },
    },
  });
  const res2 = await acp2.prompt(await acp2.newSession(), prompt);
  assert.equal(res2.result?.stopReason, "end_turn");
  assert.equal(gwSchema.requests.length, 1);
  assert.equal(gwUnreached.requests.length, 0, "gwUnreached must not be called on schema error");
  const actual2 = delivered(acp2.requests()[0]);
  assert.equal(actual2.manifest.coreSha256, expectedCore, "core preserved");
  assert.ok(actual2.manifest.omitted.some((item) => /invalid gateway response/.test(item.reason)));
});

test("innerAgent.gateway without gateways array preserves legacy failure behavior (PLUG-364 d)", async (t) => {
  const repo = setup(t);
  const gw = await gateway(t, () => ({ status: 503, raw: "Gateway Unavailable" }));
  const acp = fixture(t, repo, readAnswer, {
    settings: {
      innerAgent: {
        enabled: true,
        gateway: { baseUrl: gw.baseUrl, model: "fast-legacy" },
      },
    },
  });
  const res = await acp.prompt(await acp.newSession(), task("Read legacy single gateway test.", EN, { ref: repo.sha }));
  assert.equal(res.result?.stopReason, "end_turn");
  const actual = delivered(acp.requests()[0]);
  const omitted = actual.manifest.omitted.find((item) => item.source === "Fast agent");
  assert.ok(omitted, "must have omitted entry");
  assert.equal(omitted.reason, "gateway rejected the request (HTTP 503)");
  assert.doesNotMatch(omitted.reason, /gateway\[0\]/);
});

test("innerAgent.gateways config validation rejects remote HTTP without loopback (PLUG-364 e)", async (t) => {
  const repo = setup(t);
  for (const baseUrl of ["http://example.invalid/v1", "http://127.1/v1", "http://gateway.remote.com/compat"]) {
    const acp = fixture(t, repo, readAnswer, {
      settings: {
        innerAgent: {
          enabled: true,
          gateways: [{ baseUrl, model: "fast-remote" }],
        },
      },
    });
    const res = await acp.prompt(await acp.newSession(), task("Read remote HTTP check.", EN));
    assert.equal(res.error?.data?.outcome, "not_started");
    assert.match(res.error.message, /gateway/);
    assert.equal(acp.requests().length, 0);
  }
});

test("agentSettings parsing: chain assembly, deduplication, and single gateway ordering (PLUG-364)", async () => {
  const { agentSettings } = await import("../src/fast-agent.mjs");
  const setting = (val, def) => val ?? def;

  // 1. [gateway, ...gateways] deduplicates by (baseUrl, model) with gateway as first
  const s1 = agentSettings({
    enabled: true,
    gateway: { baseUrl: "http://127.0.0.1:8080/v1", model: "m1" },
    gateways: [
      { baseUrl: "http://127.0.0.1:8080/v1", model: "m1" },
      { baseUrl: "http://127.0.0.1:9090/v1", model: "m2", timeoutMs: 500 },
    ],
  }, setting);
  assert.equal(s1.hasChain, true);
  assert.equal(s1.gateways.length, 2);
  assert.equal(s1.gateways[0].endpoint, "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(s1.gateways[0].model, "m1");
  assert.equal(s1.gateways[1].endpoint, "http://127.0.0.1:9090/v1/chat/completions");
  assert.equal(s1.gateways[1].model, "m2");
  assert.equal(s1.gateways[1].timeoutMs, 500);

  // 2. gateways[] as-is when gateway is absent
  const s2 = agentSettings({
    enabled: true,
    gateways: [
      { baseUrl: "http://127.0.0.1:9090/v1", model: "m2" },
      { baseUrl: "http://127.0.0.1:8080/v1", model: "m1" },
    ],
  }, setting);
  assert.equal(s2.hasChain, true);
  assert.equal(s2.gateways.length, 2);
  assert.equal(s2.gateways[0].model, "m2");
  assert.equal(s2.gateways[1].model, "m1");

  // 3. single gateway without gateways -> hasChain is false
  const s3 = agentSettings({
    enabled: true,
    gateway: { baseUrl: "http://127.0.0.1:8080/v1", model: "m1" },
  }, setting);
  assert.equal(s3.hasChain, false);
  assert.equal(s3.gateways.length, 1);

  // 4. model inheritance from innerAgent.model
  const s4 = agentSettings({
    enabled: true,
    model: "shared-model",
    gateways: [
      { baseUrl: "http://127.0.0.1:8080/v1" },
      { baseUrl: "http://127.0.0.1:9090/v1", model: "override-model" },
    ],
  }, setting);
  assert.equal(s4.gateways[0].model, "shared-model");
  assert.equal(s4.gateways[1].model, "override-model");

  // 5. Invalid gateways: not an array -> throws
  assert.throws(() => agentSettings({ enabled: true, gateways: "invalid" }, setting), /gateways/);
  // 6. Invalid entry in gateways -> throws
  assert.throws(() => agentSettings({ enabled: true, gateways: [null] }, setting), /gateways/);
});

test("research-подобный ход без дерева собирает шапку без repo-строк (PLUG-370)", async (t) => {
  const { collectTask, packTask, prepareTask } = await import("../src/inner-context.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "web-gemini-research-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const nonRepoDir = join(tmp, "research");
  mkdirSync(nonRepoDir);

  const taskText = [
    "# RES-1 · Исследование интернет-источников",
    "## Description",
    "Исследуй документацию в сети.",
    "## Attachments",
    "None",
    "## Recent comments",
    "None",
    "## Report-back contract",
    "Report",
  ].join("\n\n");

  const prep = await prepareTask({
    text: taskText,
    system: null,
    session: { cwd: nonRepoDir },
    thread: { thread: { id: threadId, projectId }, environment: { path: nonRepoDir } },
    stateDir: tmp,
  });

  assert.equal(prep.root, null);
  assert.equal(prep.pin, null);

  const packageOptions = { limit: 120_000, maxTotalBytes: 100_000, spillDir: tmp, ownedFiles: [] };
  const collected = await collectTask(prep, [], [], packageOptions);
  const packed = packTask(prep, collected, packageOptions);

  const [header] = packed.message.split("\n\n=== ");
  assert.doesNotMatch(header, /<tool name="read_file"/);
  assert.doesNotMatch(header, /<tool name="list_dir"/);
  assert.doesNotMatch(header, /<tool name="grep"/);
  assert.doesNotMatch(header, /<tool name="git"/);
  assert.doesNotMatch(header, /\bgit\b/i);
  assert.doesNotMatch(header, /read_file/);
  assert.match(header, /<tool name="bb_thread_output"/);
  assert.match(header, /<tool name="bb_thread_message"/);
  assert.match(header, /<tool name="bb_task_show"/);
  assert.match(header, /bb_\* — по указанным аргументам\./);
  assert.match(header.split("\n")[0], /Для веб-поиска используй встроенные инструменты поиска Gemini\./);
  assert.doesNotMatch(header, /доступны только/);
});

test("research по явному признаку «задача без кода» в git-дереве собирает чистый research-пакет (PLUG-404)", async (t) => {
  const { collectTask, packTask, prepareTask } = await import("../src/inner-context.mjs");
  const { tmp, repo } = setup(t);

  const taskText = [
    "# RES-2 · Публичное исследование",
    "## Description",
    "Исследуй только публичные источники.",
    "## Attachments",
    "None.",
    "## Recent comments",
    "None.",
    "## Additional instructions",
    RU["instr.noCode"],
  ].join("\n\n");

  const prep = await prepareTask({
    text: taskText,
    system: null,
    session: { cwd: repo },
    thread: { thread: { id: threadId, projectId }, environment: { path: repo } },
    stateDir: tmp,
  });

  assert.equal(prep.research, true);
  assert.ok(prep.root);

  const packageOptions = { limit: 120_000, maxTotalBytes: 100_000, spillDir: tmp, ownedFiles: [] };
  const collected = await collectTask(prep, [], [], packageOptions);
  const packed = packTask(prep, collected, packageOptions);

  // Первая строка — утвердительная строка поиска по §4.6 п. 1.
  assert.match(packed.message.split("\n")[0], /Найди ответ в интернете через поиск Google/);
  assert.doesNotMatch(packed.message, /Для веб-поиска используй встроенные инструменты поиска Gemini/);
  assert.doesNotMatch(packed.message, /=== Task text ===/);
  assert.doesNotMatch(packed.message, /<tool\b/);
  assert.doesNotMatch(packed.message, /Лимит раундов/);
  assert.doesNotMatch(packed.message, /bb_\*/);
  assert.doesNotMatch(packed.message, /Git status/);
  assert.doesNotMatch(packed.message, /Git \S+ diff/);
  assert.doesNotMatch(packed.message, /Дополнения быстрого агента/);
  assert.doesNotMatch(packed.message, /Опись \/ Manifest/);
  assert.doesNotMatch(packed.message, /"permissions"/);
  assert.doesNotMatch(packed.message, /Report-back/);
  assert.doesNotMatch(packed.message, /bb tasks/);
  assert.doesNotMatch(packed.message, /Additional instructions/);
  // Короткий пакет: строка поиска + задача, а не десятки КБ инвентаря.
  assert.ok(Buffer.byteLength(packed.message) < 8_000, "research package should be short");
});

test("та же git-копия без признака research сохраняет полный репо-пакет (PLUG-384)", async (t) => {
  const { collectTask, packTask, prepareTask } = await import("../src/inner-context.mjs");
  const { tmp, repo } = setup(t);

  const taskText = [
    "# RES-3 · Задача по репозиторию",
    "## Description",
    "Разберись с состоянием дерева.",
    "## Attachments",
    "None.",
    "## Recent comments",
    "None.",
    "## Additional instructions",
    "Обычные инструкции без пометок.",
  ].join("\n\n");

  const prep = await prepareTask({
    text: taskText,
    system: null,
    session: { cwd: repo },
    thread: { thread: { id: threadId, projectId }, environment: { path: repo } },
    stateDir: tmp,
  });

  assert.equal(prep.research, false);

  const packageOptions = { limit: 120_000, maxTotalBytes: 100_000, spillDir: tmp, ownedFiles: [] };
  const collected = await collectTask(prep, [], [], packageOptions);
  const packed = packTask(prep, collected, packageOptions);

  assert.match(packed.message, /=== Git status \(index and worktree\) ===/);
  assert.match(packed.message, /=== Опись \/ Manifest ===/);
  assert.match(packed.message, /"permissions": ?"read-only"/);
});

test("роль ресерчера в системных инструкциях включает research-пакет (PLUG-384)", async (t) => {
  const { prepareTask } = await import("../src/inner-context.mjs");
  const { tmp, repo } = setup(t);

  const taskText = [
    "# RES-4 · Исследование",
    "## Description",
    "Собери сведения по вопросу.",
    "## Attachments",
    "None.",
    "## Recent comments",
    "None.",
  ].join("\n\n");

  const prep = await prepareTask({
    text: taskText,
    system: RU["role.body.researcher"],
    session: { cwd: repo },
    thread: { thread: { id: threadId, projectId }, environment: { path: repo } },
    stateDir: tmp,
  });

  assert.equal(prep.research, true);
});

test("research-сессия держит лёгкий пакет на повторных ходах; обычная сессия — полный (PLUG-384, PLUG-404)", async (t) => {
  const repo = setup(t);
  const app = fixture(t, repo, () => ({ text: "Готово." }));
  const contentOf = (request) =>
    (request.files ?? []).map((file) => file.text).join("\n") + "\n" + request.prompt;
  const assertLight = (request, isFirst = true) => {
    const content = contentOf(request);
    if (isFirst) {
      assert.match(request.prompt.split("\n")[0], /Найди ответ в интернете через поиск Google/);
    } else {
      assert.doesNotMatch(request.prompt, /Найди ответ в интернете через поиск Google/);
    }
    assert.doesNotMatch(content, /<tool\b/);
    assert.doesNotMatch(content, /Git status/);
    assert.doesNotMatch(content, /Git \S+ diff/);
    assert.doesNotMatch(content, /Дополнения быстрого агента/);
    assert.doesNotMatch(content, /Опись \/ Manifest/);
    assert.doesNotMatch(content, /"permissions"/);
  };

  const researchTask = [
    "# RES-5 · Публичное исследование",
    "## Description",
    "Исследуй только публичные источники.",
    "## Attachments",
    "None.",
    "## Recent comments",
    "None.",
    "## Additional instructions",
    RU["instr.noCode"],
  ].join("\n\n");

  const session = await app.newSession();
  const first = await app.prompt(session, researchTask);
  assert.equal(first.result?.stopReason, "end_turn", JSON.stringify(first.error));
  // Повторный ход той же сессии без маркера в тексте — всё равно лёгкий.
  const second = await app.prompt(session, "А теперь сравни ещё два варианта.");
  assert.equal(second.result?.stopReason, "end_turn", JSON.stringify(second.error));
  const [req1, req2] = app.requests();
  assertLight(req1, true);
  assertLight(req2, false);

  // Отрицательный контроль: обычная задача того же дерева без маркера
  // (отдельный экземпляр провайдера — session/new на том же worktree иначе
  // подхватывает запись research-сессии как алиас) — полный репо-пакет.
  const app2 = fixture(t, repo, () => ({ text: "Готово." }));
  const plain = await app2.newSession();
  const repoTask = [
    "# RES-6 · Задача по репозиторию",
    "## Description",
    "Разберись с состоянием дерева.",
    "## Attachments",
    "None.",
    "## Recent comments",
    "None.",
  ].join("\n\n");
  const third = await app2.prompt(plain, repoTask);
  assert.equal(third.result?.stopReason, "end_turn", JSON.stringify(third.error));
  const content = contentOf(app2.requests().at(-1));
  assert.match(content, /<tool name="read_file"/);
  assert.match(content, /=== Git status \(index and worktree\) ===/);
  assert.match(content, /=== Опись \/ Manifest ===/);
  assert.match(content, /"permissions": ?"read-only"/);
});

test("research-ход собирает явно приложенный resource_link на текст в лёгкий пакет (PLUG-384)", async (t) => {
  const repo = setup(t);
  repo.write("research/attached.txt", "PUBLIC-ATTACHMENT-ZQ9\n");
  const app = fixture(t, repo, () => ({ text: "Готово." }));

  const researchTask = [
    "# RES-7 · Публичное исследование",
    "## Description",
    "Исследуй только публичные источники.",
    "## Attachments",
    "None.",
    "## Recent comments",
    "None.",
    "## Additional instructions",
    RU["instr.noCode"],
  ].join("\n\n");

  const session = await app.newSession();
  const link = {
    type: "resource_link",
    uri: pathToFileURL(join(repo.repo, "research/attached.txt")).href,
    name: "attached",
  };
  const res = await app.prompt(session, researchTask, [link]);
  assert.equal(res.result?.stopReason, "end_turn", JSON.stringify(res.error));

  const [request] = app.requests();
  const content = request.files.map((file) => file.text).join("\n") + "\n" + request.prompt;
  // Явное вложение дошло веб-файлом — не потеряно молча.
  assert.match(content, /PUBLIC-ATTACHMENT-ZQ9/);
  // Пакет всё ещё лёгкий: без манифеста, git-секций и repo-инструментов;
  // локальные файлы репозитория сами не подбираются.
  assert.match(request.prompt.split("\n")[0], /Найди ответ в интернете через поиск Google/);
  assert.doesNotMatch(request.prompt, /<tool name="read_file"/);
  assert.doesNotMatch(content, /Опись \/ Manifest|"permissions"|Git status|different HEAD/);
});

test("research-ход: resource_link вне корней сессии — явный отказ, а не молчаливая потеря (PLUG-384)", async (t) => {
  const repo = setup(t);
  const outside = join(repo.tmp, "outside.txt");
  writeFileSync(outside, "OUTSIDE-CONTENT\n");
  const app = fixture(t, repo, () => ({ text: "Готово." }));

  const researchTask = [
    "# RES-8 · Публичное исследование",
    "## Description",
    "Исследуй только публичные источники.",
    "## Attachments",
    "None.",
    "## Recent comments",
    "None.",
    "## Additional instructions",
    RU["instr.noCode"],
  ].join("\n\n");

  const session = await app.newSession();
  const link = { type: "resource_link", uri: pathToFileURL(outside).href, name: "outside" };
  const res = await app.prompt(session, researchTask, [link]);
  assert.ok(res.error, JSON.stringify(res.result));
  assert.match(res.error.message, /mandatory ACP attachment/);
  // Ход не доехал до веб-драйвера — обязательное вложение не «0 materials».
  assert.equal(app.requests().length, 0);
});

test("research-ход: ответ с <tool.../> признаётся обычным текстом и не запускает runToolLoop (PLUG-404)", async (t) => {
  const repo = setup(t);
  const app = fixture(t, repo, (request) =>
    request.count === 1
      ? { text: '<tool name="read_file" path="docs/notes.txt"/>' }
      : { text: "Готово." });

  const researchTask = [
    "# RES-9 · Публичное исследование",
    "## Description",
    "Исследуй только публичные источники.",
    "## Attachments",
    "None.",
    "## Recent comments",
    "None.",
    "## Additional instructions",
    RU["instr.noCode"],
  ].join("\n\n");

  const session = await app.newSession();
  const res = await app.prompt(session, researchTask);
  assert.equal(res.result?.stopReason, "end_turn", JSON.stringify(res.error));

  assert.equal(app.requests().length, 1, "runToolLoop must not be launched in research mode");
  const reply = replyText(app.messages);
  assert.match(reply, /<tool name="read_file"/);
});

test("collectTaskAttachments и taskTool в research-режиме: явные вложения собираются, отказы диагностируемы (PLUG-384)", async (t) => {
  const { collectTaskAttachments, prepareTask, taskTool } = await import("../src/inner-context.mjs");
  const { tmp, repo, write } = setup(t);
  write("research/attached.txt", "PUBLIC-ATTACHMENT-ZQ9\n");
  const signal = new AbortController().signal;

  const taskText = [
    "# RES-10 · Публичное исследование",
    "## Description",
    "Исследуй публичные источники.",
    "## Attachments",
    "None.",
    "## Recent comments",
    "None.",
    "## Additional instructions",
    [RU["instr.noCode"], interpolate(RU["instr.attachList"], { list: ["docs/notes.txt"] })].join("\n"),
  ].join("\n\n");

  const prep = await prepareTask({
    text: taskText,
    system: null,
    session: { cwd: repo },
    thread: { thread: { id: threadId, projectId }, environment: { path: repo } },
    stateDir: tmp,
  });
  assert.equal(prep.research, true);
  assert.deepEqual(prep.repoFiles, ["docs/notes.txt"]);

  const options = {
    signal,
    maxUploadBytes: 1_000_000,
    maxUploadCount: 5,
    spillDir: tmp,
    validateUploads: (blocks) => ({ files: blocks.map((block) => fileURLToPath(block.uri)) }),
  };
  const link = { type: "resource_link", uri: pathToFileURL(join(repo, "research/attached.txt")).href };

  // Явно приложенный текст собирается через ACP-валидацию.
  const materials = await collectTaskAttachments(prep, [link], options);
  assert.equal(materials.length, 1);
  assert.equal(materials[0].source, "ACP attachment");
  assert.match(materials[0].text, /PUBLIC-ATTACHMENT-ZQ9/);
  // repoFiles из инструкций в light по-прежнему исключены.
  assert.ok(!materials.some((item) => /different HEAD/.test(item.text)));

  // Отказ валидации — явная ошибка, не «0 materials».
  await assert.rejects(
    collectTaskAttachments(prep, [link], { ...options, validateUploads: () => ({ error: "denied" }) }),
    /mandatory ACP attachment/,
  );
  // Бинарное вложение — тоже явный отказ, не молчаливый пропуск.
  await assert.rejects(
    collectTaskAttachments(prep, [{ type: "image", path: join(repo, "picture.bin") }], options),
    /mandatory attachment is binary/,
  );

  // Инструменты дерева в light — отказ.
  for (const [name, args] of [
    ["read_file", { path: "docs/notes.txt" }],
    ["list_dir", { path: "." }],
    ["grep", { pattern: "HEAD" }],
    ["git", { args: "status" }],
  ]) {
    const result = await taskTool(prep, {}, { name, args, attrs: [] }, 60_000, signal);
    assert.equal(result.ok, false, name);
    assert.match(result.output, /^error: .*unavailable/, name);
  }

  // Репо-режим неизменён: тот же read_file читает рабочую копию.
  const plain = await prepareTask({
    text: taskText.replace(RU["instr.noCode"], "Обычные инструкции без пометок."),
    system: null,
    session: { cwd: repo },
    thread: { thread: { id: threadId, projectId }, environment: { path: repo } },
    stateDir: tmp,
  });
  assert.equal(plain.research, false);
  const read = await taskTool(plain, {}, { name: "read_file", args: { path: "docs/notes.txt" }, attrs: [] }, 60_000, signal);
  assert.equal(read.ok, true);
  assert.match(read.output, /different HEAD/);
});

test("офлайн-тест сборки research-пакета на seed-1938.md (PLUG-404)", async (t) => {
  const { collectTask, packTask, prepareTask } = await import("../src/inner-context.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "web-gemini-seed-1938-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const fixtureSeedPath = fileURLToPath(new URL("./fixtures/seed-1938.md", import.meta.url));
  const taskText = readFileSync(fixtureSeedPath, "utf8");

  const prep = await prepareTask({
    text: taskText,
    system: null,
    session: { cwd: tmp },
    thread: { thread: { id: threadId, projectId }, environment: { path: tmp } },
    stateDir: tmp,
  });

  assert.equal(prep.research, true);

  const packageOptions = { limit: 120_000, maxTotalBytes: 100_000, spillDir: tmp, ownedFiles: [] };
  const collected = await collectTask(prep, [], [], packageOptions);
  const packed = packTask(prep, collected, packageOptions);

  // Проверить первую строку
  assert.match(packed.message.split("\n")[0], /^Найди ответ в интернете через поиск Google\. Для каждого факта укажи ссылку на источник и дату\.$/);

  // Проверить, что в собранном пакете ОТСУТСТВУЮТ подстроки:
  // <tool , Лимит раундов, Report-back, bb tasks, Additional instructions, === Task text ===, [скрыто: task-key].
  const forbidden = [
    "<tool ",
    "Лимит раундов",
    "Report-back",
    "bb tasks",
    "Additional instructions",
    "=== Task text ===",
    "[скрыто: task-key].",
  ];
  for (const sub of forbidden) {
    assert.doesNotMatch(packed.message, new RegExp(sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `собранный пакет не должен содержать "${sub}"`);
  }

  // Проверить, что подстрока GLM-5.3-Flash сохранена в исходном виде
  assert.ok(packed.message.includes("GLM-5.3-Flash"), "подстрока GLM-5.3-Flash должна быть сохранена");

  // Маскировка ключа задачи PLUG-399
  assert.doesNotMatch(packed.message, /\bPLUG-399\b/);
  assert.match(packed.message, /# \[скрыто: task-key\] · research:/);
});

test("filterServiceLines: фильтрует закрытый список служебных строк и блок git (PLUG-404)", async () => {
  const { filterServiceLines } = await import("../src/inner-context.mjs");

  const sample = [
    "задача без кода: файлы репозитория не менять, не коммитить; итог — отчёт",
    "no-code task: do not change files",
    "Проверяемый итог: коммит 94c182d6",
    "Result under review: commit 94c182d6",
    "Приложенные файлы (прочитай в репозитории): `foo.ts`, `bar.ts`",
    "Attached files (read them in the repo): `foo.ts`",
    "Работа с git:",
    "- ветки не трогать",
    "- коммитить локально",
    "",
    "Git work:",
    "- do not push",
    "",
    "Сохранить этот текст вопроса.",
    "И эту строку тоже.",
  ].join("\n");

  const filtered = filterServiceLines(sample);
  assert.equal(filtered, "Сохранить этот текст вопроса.\nИ эту строку тоже.");

  // Проверка замечания 5: /^\s*(?:Работа с git|Git work):/ без i и без пропуска :
  // Строка без двоеточия или в другом регистре не считается началом блока git.
  const falseMatches = [
    "git work is very important",
    "работа с git без двоеточия",
    "Git work without colon",
  ].join("\n");
  assert.equal(filterServiceLines(falseMatches), falseMatches);
});

test("research-пакет включает встроенные ACP resource-вложения без маркеров === (PLUG-404 п. 1)", async (t) => {
  const { collectTask, collectTaskAttachments, packTask, prepareTask } = await import("../src/inner-context.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "web-gemini-resource-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const taskText = [
    "# PLUG-404 · research: проверка вложений",
    "",
    "## Description",
    "Текст задачи исследования.",
    "",
    "## Additional instructions",
    "задача без кода: файлы репозитория не менять",
  ].join("\n");

  const prep = await prepareTask({
    text: taskText,
    system: null,
    session: { cwd: tmp },
    thread: { thread: { id: threadId, projectId }, environment: { path: tmp } },
    stateDir: tmp,
  });

  const blocks = [
    { type: "resource", resource: { uri: "memo://notes.txt", text: "Содержимое ресурсного блока ACP." } },
  ];

  const packageOptions = {
    limit: 100_000,
    maxTotalBytes: 100_000,
    spillDir: tmp,
    ownedFiles: [],
    signal: new AbortController().signal,
    maxUploadBytes: 50_000,
    maxUploadCount: 5,
    validateUploads: () => ({ files: [] }),
  };
  const materials = await collectTaskAttachments(prep, blocks, packageOptions);
  const collected = await collectTask(prep, blocks, materials, packageOptions);
  const packed = packTask(prep, collected, packageOptions);

  // Ресурсный блок включён в текст сообщения
  assert.ok(packed.message.includes("Содержимое ресурсного блока ACP."), "содержимое resource-блока должно быть в сообщении");
  // Без маркеров ===
  assert.doesNotMatch(packed.message, /===/);
  // Первая строка — поисковая директива
  assert.match(packed.message.split("\n")[0], /^Найди ответ в интернете через поиск Google/);
});

test("research-пакет при переполнении лимита переливается в файл, сохраняя строку поиска (PLUG-404 п. 3)", async (t) => {
  const { collectTask, packTask, prepareTask } = await import("../src/inner-context.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "web-gemini-spill-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const taskText = [
    "# PLUG-404 · research: длинная задача для перелива",
    "",
    "## Description",
    "Очень длинное описание задачи. ".repeat(50),
    "",
    "## Additional instructions",
    "задача без кода: файлы репозитория не менять",
  ].join("\n");

  const prep = await prepareTask({
    text: taskText,
    system: null,
    session: { cwd: tmp },
    thread: { thread: { id: threadId, projectId }, environment: { path: tmp } },
    stateDir: tmp,
  });

  // Задаём маленький лимит сообщения (500 байт), чтобы гарантировать spill
  const packageOptions = { limit: 500, maxTotalBytes: 100_000, spillDir: tmp, ownedFiles: [] };
  const collected = await collectTask(prep, [], [], packageOptions);
  const packed = packTask(prep, collected, packageOptions);

  // В сообщении остаётся строка поиска + указатель на приложенный файл без упоминания манифеста
  assert.match(packed.message.split("\n")[0], /^Найди ответ в интернете через поиск Google/);
  assert.match(packed.message, /Read the entire task in the attached pkg-[0-9a-f-]+\.md\./);
  assert.doesNotMatch(packed.message, /manifest/i);
  assert.equal(packed.files.length, 1);
  assert.ok(existsSync(packed.files[0]));
});

test("research-пакет не обрезает Preset/Additional instructions на авторском ## (PLUG-404 п. 4)", async (t) => {
  const { collectTask, packTask, prepareTask } = await import("../src/inner-context.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "web-gemini-subheading-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const taskText = [
    "# PLUG-404 · research: сохранение авторских ## подзаголовков",
    "",
    "## Description",
    "Основное описание.",
    "",
    "## Preset instructions",
    "Вводная часть пресета.",
    "## Авторский подраздел в пресете",
    "Содержимое авторского подраздела пресета.",
    "",
    "## Additional instructions",
    "задача без кода: файлы репозитория не менять",
    "Вводная часть дополнительных инструкций.",
    "## Авторский подраздел в дополнительных",
    "Содержимое авторского подраздела дополнительных инструкций.",
    "",
    "## Report-back contract",
    "Служебный раздел контракта, который должен быть отсечён.",
  ].join("\n");

  const prep = await prepareTask({
    text: taskText,
    system: null,
    session: { cwd: tmp },
    thread: { thread: { id: threadId, projectId }, environment: { path: tmp } },
    stateDir: tmp,
  });

  assert.equal(prep.research, true);

  const packageOptions = { limit: 100_000, maxTotalBytes: 100_000, spillDir: tmp, ownedFiles: [] };
  const collected = await collectTask(prep, [], [], packageOptions);
  const packed = packTask(prep, collected, packageOptions);

  assert.ok(packed.message.includes("## Авторский подраздел в пресете"), "авторский ## подраздел в Preset должен быть сохранён");
  assert.ok(packed.message.includes("Содержимое авторского подраздела пресета."), "содержимое авторского ## в Preset должно быть сохранено");
  assert.ok(packed.message.includes("## Авторский подраздел в дополнительных"), "авторский ## подраздел в Additional должен быть сохранён");
  assert.ok(packed.message.includes("Содержимое авторского подраздела дополнительных инструкций."), "содержимое авторского ## в Additional должно быть сохранено");
  assert.doesNotMatch(packed.message, /Report-back/);
  assert.doesNotMatch(packed.message, /Служебный раздел контракта/);
});
