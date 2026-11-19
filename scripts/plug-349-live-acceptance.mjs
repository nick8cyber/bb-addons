#!/usr/bin/env node
// PLUG-349 — live acceptance of the web-gemini-files-v2 write path (spec §12.3).
//
// Drives the real provider through the plugin-sdk ACP bridge with
// permissionMode "accept-edits" against a live Chrome account from the pool.
// Everything synthetic lives under the given run dir: a throwaway git repo, a
// dedicated worktree the provider writes into, a private provider state dir,
// and a fake `bb` CLI that answers `bb thread show` with the fixture identity.
// The provider process itself performs the dual-channel capture (RPC history
// hNvQHb + DOM textContent), envelope verification, write and single commit.
//
// Usage:
//   node scripts/plug-349-live-acceptance.mjs <pluginDir> <runDir> <configJson>
// configJson fields:
//   threadId        fixture BB thread id (default "thr" + "_xxxxxxxxxx")
//   account / cdp   pick the pool account by id or CDP port (required)
//   poolSource      pool.json to read accounts from
//                   (default ~/.bb/plugins/provider-argon/pool.json)
//   sdkDir          dir containing node_modules/@get-bb/plugin-sdk
//                   (default ~/.local/share/web-gemini)
//   model           session model (default argon)
//   thinking        thought_level low|medium|high (default high)
//   branch          fixture branch name (default fixture-write)
//   files           result-file paths for the "## Файлы результата" section
//   task            prompt text template ({files} is replaced with the list)
//   taskFile        read the prompt text from a file instead
//   timeoutMs       journal-outcome wait limit (default 1 350 000)
// Result: <runDir>/summary.json plus observations.jsonl, repairs/*.txt and the
// turn journal under <runDir>/state. Exit 0 on "passed" with verified hashes.

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const [pluginDir, runDir, configJson] = process.argv.slice(2);
if (!pluginDir || !runDir || !configJson) {
  console.error("usage: plug-349-live-acceptance.mjs <pluginDir> <runDir> <configJson>");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(configJson, "utf8"));
const plugin = pluginDir;
const threadId = cfg.threadId ?? "thr" + "_xxxxxxxxxx";
const projectId = cfg.projectId ?? "proj" + "_xxxxxxxxxx";
const repo = join(runDir, "seed");
const cwd = join(runDir, "worktree");
const state = join(runDir, "state");
const branch = cfg.branch ?? "fixture-write";
const timeoutMs = cfg.timeoutMs ?? 1_350_000;
const resultFiles = cfg.files ?? ["docs/reminder-scheduler.md"];
mkdirSync(repo, { recursive: true, mode: 0o700 });
mkdirSync(state, { recursive: true, mode: 0o700 });

const git = (where, ...args) => execFileSync("git", args, { cwd: where, encoding: "utf8" }).trimEnd();
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.name", "Fixture");
git(repo, "config", "user.email", "fixture@example.invalid");
writeFileSync(join(repo, "README.md"), "Synthetic spec acceptance repository (PLUG-349).\n");
git(repo, "add", "README.md");
git(repo, "commit", "-qm", "Fixture base");
git(repo, "worktree", "add", "-qb", branch, cwd);
const base = git(cwd, "rev-parse", "HEAD");

// The account must already have a logged-in Chrome on its CDP port
// (GEMINI_NO_AUTOSPAWN=1 keeps the driver attached, never respawning).
const poolSource = cfg.poolSource ?? join(homedir(), ".bb/plugins/provider-argon/pool.json");
const account = JSON.parse(readFileSync(poolSource, "utf8")).accounts.find((a) =>
  (cfg.account && a.id === cfg.account) || (cfg.cdp && String(a.cdpPort ?? a.cdp) === String(cfg.cdp)));
if (!account) throw new Error("pool account not found for " + JSON.stringify({ account: cfg.account, cdp: cfg.cdp }));
const pool = join(runDir, "pool.json");
writeFileSync(pool, JSON.stringify({ accounts: [account] }), { mode: 0o600 });

const bb = join(runDir, "fake-bb");
const dto = {
  thread: { id: threadId, projectId, originPluginId: "test" },
  environment: { path: cwd, branchName: branch, managed: true, isGitRepo: true, isWorktree: true },
};
writeFileSync(bb, "#!" + process.execPath + "\n" +
  "if (process.argv.slice(2).join(' ') === " + JSON.stringify("thread show " + threadId + " --json") + ") console.log(" +
  JSON.stringify(JSON.stringify(dto)) + "); else process.exitCode = 2;\n", { mode: 0o700 });

// The bridge worker loads host.mjs to obtain the experimental_providerBridge
// export; resolving the SDK by absolute file URL keeps the plugin checkout
// free of a node_modules install.
const sdkDir = cfg.sdkDir ?? join(homedir(), ".local/share/web-gemini");
const sdkRoot = join(sdkDir, "node_modules/@get-bb/plugin-sdk");
const hostShim = join(runDir, "host.mjs");
writeFileSync(hostShim,
  "export { experimental_acpProviderBridge as experimental_providerBridge } from " +
  JSON.stringify(pathToFileURL(join(sdkRoot, "dist/provider-bridge-acp.js")).href) + ";\n",
  { mode: 0o600 });

// Instrumented provider: wraps the real driver and logs every generation and
// the file-envelope gate verdict per response. Repair prompts are stored
// verbatim — the live acceptance must quote the named cause (§8.1).
const entry = join(runDir, "entry.mjs");
const uri = (file) => JSON.stringify(pathToFileURL(join(plugin, file)).href);
writeFileSync(entry, [
  "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
  "import { createHash } from 'node:crypto';",
  "import { startServer } from " + uri("acp-server.mjs") + ";",
  "import driver from " + uri("src/gemini-driver.js") + ";",
  "import envelope from " + uri("src/file-envelope.cjs") + ";",
  "const obs = " + JSON.stringify(join(runDir, "observations.jsonl")) + ";",
  "const repairs = " + JSON.stringify(join(runDir, "repairs")) + ";",
  "const sha = (t) => createHash('sha256').update(String(t ?? ''), 'utf8').digest('hex');",
  "const log = (v) => appendFileSync(obs, JSON.stringify(v) + '\\n');",
  "let seq = 0; let repairSeq = 0;",
  "startServer({ webDriver: { async sendPrompt(options) {",
  "  const n = ++seq;",
  "  const isRepair = options.prompt.includes('Correct the previous reply');",
  "  if (isRepair) { mkdirSync(repairs, { recursive: true }); writeFileSync(repairs + '/repair-' + (++repairSeq) + '.txt', options.prompt); }",
  "  log({ kind: 'send', n, at: Date.now(), repair: isRepair, fileCapture: Boolean(options.fileCapture),",
  "       promptSha: sha(options.prompt), promptBytes: Buffer.byteLength(options.prompt), model: options.model, thinking: options.thinking,",
  "       promptTail: options.prompt.slice(-600) });",
  "  const t0 = Date.now();",
  "  let result;",
  "  try { result = await driver.sendPrompt(options); }",
  "  catch (error) { log({ kind: 'error', n, at: Date.now(), ms: Date.now() - t0, code: error.code, reason: String(error.message).slice(0, 400) }); throw error; }",
  "  const gate = envelope.verifyFileResponse(result.fileResponse, options.fileCapture?.nonce);",
  "  log({ kind: 'gate', n, at: Date.now(), ms: Date.now() - t0, repair: gate.repair ?? null, recapture: gate.recapture ?? null,",
  "       formatPass: Boolean(gate.plan), files: gate.plan?.files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content ?? ''), sha: f.sha256 })),",
  "       rpcId: result.fileResponse?.rpc?.id ?? null, domId: result.fileResponse?.dom?.id ?? null,",
  "       rpcBytes: result.fileResponse?.rpc?.text ? Buffer.byteLength(result.fileResponse.rpc.text) : null,",
  "       domBytes: result.fileResponse?.dom?.text ? Buffer.byteLength(result.fileResponse.dom.text) : null,",
  "       rpcInvalid: result.fileResponse?.rpc?.invalid ?? null, domInvalid: result.fileResponse?.dom?.invalid ?? null });",
  "  return result;",
  "} } });",
].join("\n"), { mode: 0o600 });

const worker = join(sdkRoot, "dist/provider-bridge-worker-entry.mjs");
const child = spawn(process.execPath, [worker, hostShim, "provider-fixture", runDir], {
  env: process.env, stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
const messages = [];
const notifications = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  messages.push(msg);
  if (msg.method) notifications.push(msg);
});
let id = 0;
function send(method, params) {
  const request = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: request, method, params }) + "\n");
  return until(() => messages.find((msg) => msg.id === request), 60_000);
}
async function until(fn, timeout) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    const result = fn();
    if (result) return result;
    if (child.exitCode !== null) throw new Error("bridge exited with code " + child.exitCode);
    await delay(200);
  }
  throw new Error("fixture timed out");
}
const options = {
  permissionMode: "accept-edits", permissionScope: "workspace", approvalReviewer: "user", permissionEscalation: "deny",
  model: cfg.model ?? "argon",
  reasoningLevel: cfg.thinking ?? "high",
  sessionOptions: { thought_level: cfg.thinking ?? "high", ...(cfg.sessionOptions ?? {}) },
  providerOptions: { acpDialect: "generic", acpLaunchSpec: {
    displayName: "Gemini live acceptance (PLUG-349)", command: process.execPath, args: [entry, "--bb-thread-id=" + threadId],
    permissionCli: { insertAfterArgs: 1, full: ["--session-access=read-only"], workspaceWrite: ["--session-access=write"] },
    env: {
      BB_CLI: bb, WEB_GEMINI_STATE_DIR: state, WEB_GEMINI_POOL_FILE: pool,
      WEB_GEMINI_FAKE: "0", ARGON_FAKE: "0", WEB_GEMINI_BACKENDS: "[]",
      GEMINI_NO_AUTOSPAWN: "1", WEB_GEMINI_HEADLESS: "xvfb",
      WEB_GEMINI_SEND_DEADLINE_MS: "1200000",
    },
  } },
};
const taskText = cfg.taskFile
  ? readFileSync(cfg.taskFile, "utf8")
  : (cfg.task ?? "Write an original Markdown engineering specification.\n\n## Файлы результата\n{files}")
    .replace("{files}", resultFiles.map((f) => "- " + f).join("\n"));

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  const session = await send("thread/start", { threadId, cwd, instructionMode: "replace", options });
  if (!session.result?.providerThreadId) throw new Error(JSON.stringify(session.error ?? session.result));
  console.log("[plug-349] bridge started, providerThreadId=" + session.result.providerThreadId);
  if (cfg.dryRun) {
    await delay(1500);
    writeFileSync(join(runDir, "summary.json"), JSON.stringify({ dryRun: true, notifications }, null, 2) + "\n");
    console.log("[plug-349] dryRun complete, notifications=" + notifications.length);
    child.stdin.end(); child.kill();
    process.exit(0);
  }
  const startTime = Date.now();
  const turn = await send("turn/start", {
    threadId, providerThreadId: session.result.providerThreadId, clientRequestId: "creq_fixture349",
    input: [{ type: "text", text: taskText }], options,
  });
  if (!turn.result) throw new Error(JSON.stringify(turn.error));
  console.log("[plug-349] turn accepted, waiting for journal outcome");
  const record = await until(() => {
    const root = join(state, "inner-agent/turns");
    if (!existsSync(root)) return null;
    for (const key of readdirSync(root)) {
      for (const dir of readdirSync(join(root, key))) {
        const file = join(root, key, dir, "record.json");
        if (!existsSync(file)) continue;
        const data = JSON.parse(readFileSync(file, "utf8"));
        if (data.outcome) return { data, dir: join(root, key, dir) };
      }
    }
    return null;
  }, timeoutMs);
  const { data, dir: turnDir } = record;
  const final = { outcome: data.outcome, reason: data.reason ?? null, durationMs: Date.now() - startTime,
    stage: data.stage ?? null, repairs: data.budgets?.repairRounds ?? null,
    commits: Number(git(cwd, "rev-list", "--count", base + "..HEAD")),
    clean: !git(cwd, "status", "--porcelain"), branch: git(cwd, "branch", "--show-current"),
    deadlineMs: 1_200_000 };
  if (data.commit) {
    final.sha = git(cwd, "rev-parse", "HEAD");
    final.parentIsBase = git(cwd, "show", "-s", "--format=%P", "HEAD").trim() === base;
    final.commitShaMatchesRecord = final.sha === data.commit.sha;
    const manifest = JSON.parse(readFileSync(join(turnDir, "file-response/manifest.json"), "utf8"));
    final.manifest = manifest;
    final.files = manifest.files.map((file) => {
      if (file.operation === "delete") return { path: file.path, operation: "delete", deleted: !existsSync(join(cwd, file.path)) };
      const worktree = readFileSync(join(cwd, file.path));
      const index = execFileSync("git", ["show", ":" + file.path], { cwd });
      const commit = execFileSync("git", ["show", "HEAD:" + file.path], { cwd });
      const contentHash = hash(worktree);
      return {
        path: file.path, operation: file.operation, bytes: worktree.length,
        channelSha256: file.sha256,
        worktreeMatch: contentHash === file.sha256,
        indexMatch: hash(index) === file.sha256,
        commitMatch: hash(commit) === file.sha256,
      };
    });
    final.allFilesVerified = final.files.every((f) => f.operation === "delete" ? f.deleted : f.worktreeMatch && f.indexMatch && f.commitMatch);
  }
  // Independent re-verification of both stored channels with the production
  // verifier, in addition to the provider-side gate observations.
  const manifestPath = join(turnDir, "file-response/manifest.json");
  if (existsSync(manifestPath) && existsSync(join(turnDir, "file-response/history.md.txt"))) {
    const env = await import(pathToFileURL(join(plugin, "src/file-envelope.cjs")).href);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const rpcText = readFileSync(join(turnDir, "file-response/history.md.txt"), "utf8");
    const domText = readFileSync(join(turnDir, "file-response/dom.json.txt"), "utf8");
    const verify = env.verifyFileResponse ?? env.default.verifyFileResponse;
    const checked = verify(
      { rpc: { id: manifest.messageId, text: rpcText }, dom: { id: manifest.messageId, text: domText } },
      manifest.nonce);
    final.channelRecheck = checked.plan
      ? { plan: true, filesMatchManifest: checked.plan.files.every((f, i) => f.sha256 === manifest.files[i].sha256) }
      : { repair: checked.repair ?? null, recapture: checked.recapture ?? null };
  }
  await delay(1200);
  final.progressEvents = notifications.filter((msg) => /turn|item|tool/i.test(String(msg.method))).length;
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(final, null, 2) + "\n");
  console.log(JSON.stringify(final));
  if (final.outcome !== "passed") process.exitCode = 1;
} finally { child.stdin.end(); child.kill(); }
