/**
 * Proves what the bridge does with agy's artifact-path refusal, at no quota
 * cost. Three sessions, three shapes (see fake-agy-artifact.mjs):
 *
 *   recover  a refusal the nudge fixes            -> one completed turn
 *   persist  a refusal that keeps coming back on
 *            a turn that answered anyway          -> completed, thread lives
 *   silent   a refusal on a turn with no answer   -> failed, and the message
 *                                                   names the real cause
 *
 * Usage: node harness-artifact.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agy-artifact-"));
const transcript = join(root, "stdin.ndjson");
writeFileSync(transcript, "");
const shim = join(root, "agy-shim");
const fake = new URL("./fake-agy-artifact.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
// hermetic: the host may or may not have an agent-proxy core to auto-detect
process.env.AGY_CLIPROXY = "0";
process.env.AGY_FAKE_TRANSCRIPT = transcript;
const workspace = (mode) => {
  const dir = join(root, `ws-${mode}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const messages = [];
const originalWrite = process.stdout.write.bind(process.stdout);
let tail = "";
process.stdout.write = (chunk) => {
  tail += typeof chunk === "string" ? chunk : chunk.toString();
  for (;;) {
    const nl = tail.indexOf("\n");
    if (nl === -1) break;
    const line = tail.slice(0, nl);
    tail = tail.slice(nl + 1);
    if (line.trim().length === 0) continue;
    try { messages.push(JSON.parse(line)); } catch { messages.push({ __nonJson: line }); }
  }
  return true;
};
const say = (...a) => originalWrite(`${a.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { experimental_providerBridge: bridge } = await import(
  new URL("./dist/host.js", import.meta.url).href
);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
const send = (m) => bridge.handleLine(JSON.stringify(m));
const pol = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const options = { model: "fake-model", ...pol };
const deltas = (threadId) =>
  messages
    .filter((m) => m.method === "thread/delta" && m.params.threadId === threadId)
    .flatMap((m) => m.params.deltas);
const completed = (threadId) =>
  deltas(threadId).filter((delta) => delta.kind === "turn.boundary");

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      process.stdout.write = originalWrite;
      say(`!!! timeout: ${label}`);
      for (const m of messages) say(JSON.stringify(m).slice(0, 300));
      process.exit(2);
    }
    await sleep(50);
  }
}

let nextId = 10;
let creqSeq = 0;
async function drive(mode, prompts) {
  const threadId = `t-${mode}`;
  send({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: 2, grammarVersions: [3, 3], client: { name: "fake", version: "1" } } });
  const startId = nextId++;
  send({ jsonrpc: "2.0", id: startId, method: "thread/start", params: { threadId, cwd: workspace(mode), options, instructionMode: "append" } });
  await waitFor(() => messages.some((m) => m.id === startId), 15_000, `${mode}: thread/start`);
  for (let i = 0; i < prompts.length; i += 1) {
    send({
      jsonrpc: "2.0", id: nextId++, method: "turn/start",
      params: {
        threadId, providerThreadId: "fake-conv-artifact",
        input: [{ type: "text", text: prompts[i], mentions: [] }],
        clientRequestId: `creq_${"abcdefghij".slice(0, 9)}${"bcdefghij"[creqSeq++]}`,
        options,
      },
    });
    await waitFor(() => completed(threadId).length >= i + 1, 15_000, `${mode}: turn ${i + 1}`);
  }
  send({ jsonrpc: "2.0", id: nextId++, method: "thread/stop", params: { threadId, providerThreadId: "fake-conv-artifact", intent: "release", activeTurnId: null } });
  return threadId;
}

const recover = await drive("recover", ["create src/Foo.tsx", "now also src/Bar.tsx"]);
const persist = await drive("persist", ["create src/Foo.tsx"]);
const silent = await drive("silent", ["create src/Foo.tsx"]);
bridge.onClose?.();
process.stdout.write = originalWrite;

const lines = readFileSync(transcript, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).message.content);
const silentFail = completed(silent).find((t) => t.status === "failed");

const checks = [
  ["recover/turn-completes", completed(recover).length === 2 && completed(recover).every((t) => t.status === "completed"), JSON.stringify(completed(recover).map((t) => t.status))],
  ["recover/one-turn-id-per-message", new Set(completed(recover).map((t) => t.providerTurnId)).size === 2, ""],
  ["recover/no-error-surfaced", deltas(recover).filter((delta) => delta.kind === "provider.error").length === 0, ""],
  ["recover/nudge-names-the-file", lines.some((l) => /Look at .*src\/Foo\.tsx on disk now/.test(l)), JSON.stringify(lines.find((l) => l.startsWith("Your last")) ?? "").slice(0, 90)],
  ["recover/guardrail-on-later-turns", lines.some((l) => l.startsWith("[workspace rule]") && l.endsWith("now also src/Bar.tsx")), ""],
  ["recover/no-guardrail-before-the-refusal", lines[0] === "create src/Foo.tsx", JSON.stringify(lines[0] ?? "")],
  ["persist/answered-turn-is-not-a-failure", completed(persist).length === 1 && completed(persist)[0].status === "completed", JSON.stringify(completed(persist).map((t) => t.status))],
  // One nudge per refused turn and never a second on the same turn: three
  // refused turns across the three sessions, three nudges.
  ["all/one-re-drive-per-refused-turn", lines.filter((l) => l.startsWith("Your last write_to_file")).length === 3, `${lines.filter((l) => l.startsWith("Your last write_to_file")).length} nudges across 3 sessions`],
  ["silent/answerless-turn-fails", silentFail !== undefined, JSON.stringify(completed(silent).map((t) => t.status))],
  ["silent/message-names-the-cause", silentFail !== undefined && /ArtifactMetadata field \(an agy bug/.test(silentFail.error.message), JSON.stringify(silentFail?.error?.message ?? "").slice(0, 120)],
];

say("==== artifact-refusal handling report ====");
for (const [id, ok, detail] of checks) say(`${ok ? "pass" : "FAIL"} ${id.padEnd(40)} ${detail}`);
const bad = checks.filter(([, ok]) => !ok).length;
say(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad === 0 ? 0 : 1);
