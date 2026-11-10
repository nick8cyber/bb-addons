/**
 * ACP transport harness: drives the built dist/host.js wrapper in-process
 * against fake-agy-acp.mjs. Covers spec §11: pool+sticky, quota rotation
 * with handoff, whole-pool cooldown → rateLimits+retry, resume on a cooled
 * owner, turn/start on a cooled session, compact fallback (2 stages),
 * artifact guardrail+nudge, hanging interaction resolution, two parallel
 * threads on one account.
 *
 * Usage: node harness-acp.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "agy-acp-"));
const workspace = join(root, "ws");
mkdirSync(workspace, { recursive: true });
const shim = join(root, "agy-bin");
const fake = new URL("./fake-agy-acp.mjs", import.meta.url).pathname;
writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/node ${fake} "$@"\n`);
chmodSync(shim, 0o755);
process.env.AGY_PATH = shim;
process.env.AGY_CLIPROXY = "0";
process.env.AGY_FAKE_TRANSCRIPT = join(root, "transcript.ndjson");
process.env.AGY_FAKE_RECORD_ENV = "HTTPS_PROXY,AGY_DISABLE_SUBAGENTS";
process.env.AGY_FAKE_QUOTA_MSG = "Quota exhausted; retry later. Resets in 0h0m3s.";
process.env.AGY_FAKE_CONTROL = join(root, "control.json");
writeFileSync(process.env.AGY_FAKE_CONTROL, "{}\n");
const setControl = (obj) => { const c = JSON.parse(readFileSync(process.env.AGY_FAKE_CONTROL, "utf8")); Object.assign(c, obj); writeFileSync(process.env.AGY_FAKE_CONTROL, JSON.stringify(c)); };
process.env.AGY_AUTO_RETRY_MAX = "2";
process.env.AGY_AUTO_RETRY_MAX_WAIT_MS = "30000";

// Pool accounts a1..a4 (a2 has a proxy).
for (const label of ["a1", "a2", "a3", "a4"]) {
  const cli = join(root, "accounts", label, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), '{"auth_method":"consumer"}\n');
}
writeFileSync(join(root, "accounts", "a2", "proxy"), "http://proxy-a2:9\n");

const transcriptLines = () =>
  existsSync(join(root, "transcript.ndjson"))
    ? readFileSync(join(root, "transcript.ndjson"), "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    : [];
const prompts = (home) => transcriptLines().filter((l) => l.method === "session/prompt" && l.home === home);
const ptxt0 = (p) => (p?.params?.prompt ?? []).map((b) => b.text ?? "").join("\n");
const news = (home) => transcriptLines().filter((l) => l.method === "session/new" && l.home === home);
const loads = (home) => transcriptLines().filter((l) => l.method === "session/load" && l.home === home);
const setModes = (home) => transcriptLines().filter((l) => l.method === "session/set_mode" && l.home === home);
const ledger = () => JSON.parse(readFileSync(join(root, "accounts-state.json"), "utf8"));
const cool = (label, untilIn) => {
  const l = ledger();
  l.accounts[label] = { ...(l.accounts[label] ?? { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null }), cooldownUntilMs: Date.now() + untilIn, lastError: "test" };
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(l));
};
const say = (...a) => process.stderr.write(`${a.join(" ")}\n`);

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

const { experimental_providerBridge: bridge } = await import(new URL("./dist/host.js", import.meta.url).href);
bridge.start?.({ pluginId: "provider-agy", dataDir: root, tempDir: root });
const send = (m) => bridge.handleLine(JSON.stringify(m));
const options = { model: "fake-model", permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
let creqN = 0;
const creq = () => `creq_${"aaaaaaaaaa".slice(0, 9)}${"abcdefghjkmnpqrstuvwxyz"[creqN++ % 24]}`;

const deltas = (tid) => messages.filter((m) => m.method === "thread/delta" && m.params.threadId === tid).flatMap((m) => m.params.deltas);
const boundaries = (tid) => deltas(tid).filter((d) => d.kind === "turn.boundary");
const opens = (tid) => deltas(tid).filter((d) => d.kind === "turn.open");
const perrors = (tid) => deltas(tid).filter((d) => d.kind === "provider.error");
const rateLimits = (tid) => deltas(tid).filter((d) => d.kind === "provider.rateLimits");
const usages = (tid) => deltas(tid).filter((d) => d.kind === "usage");
const cws = (tid) => deltas(tid).filter((d) => d.kind === "contextWindow");
const replaced = (tid) => messages.filter((m) => m.method === "session/replaced" && m.params.threadId === tid);
const replies = (id) => messages.filter((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
const errors = (tid) => messages.filter((m) => m.method === "error" && m.params?.threadId === tid);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) {
      say(`!!! timeout: ${label}`);
      for (const m of messages.slice(-40)) say(JSON.stringify(m).slice(0, 300));
      say("--- transcript ---");
      for (const l of transcriptLines().slice(-40)) say(JSON.stringify(l).slice(0, 300));
      process.exit(2);
    }
    await sleep(40);
  }
}
const threadReqIds = { t1: 1, t2: 10, t3: 50, t4: 51 };
const ptidOf = (tid) => replies(threadReqIds[tid] ?? -1)[0]?.result?.providerThreadId
  ?? messages.filter((m) => m.method === "thread/identity" && m.params.threadId === tid).at(-1)?.params.providerThreadId
  ?? "?";
const start = (id, tid) => send({ jsonrpc: "2.0", id, method: "thread/start", params: { threadId: tid, cwd: workspace, options, instructionMode: "append" } });
const turn = (id, tid, text) => send({ jsonrpc: "2.0", id, method: "turn/start", params: { threadId: tid, providerThreadId: ptidOf(tid), input: [{ type: "text", text, mentions: [] }], clientRequestId: creq(), options } });
const resume = (id, tid, ptid) => send({ jsonrpc: "2.0", id, method: "thread/resume", params: { threadId: tid, cwd: workspace, providerThreadId: ptid, options, instructionMode: "append" } });
const stop = (id, tid, intent = "release") => send({ jsonrpc: "2.0", id, method: "thread/stop", params: { threadId: tid, providerThreadId: ptidOf(tid), intent, activeTurnId: null } });

send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 2, client: { name: "harness", version: "1" }, grammarVersions: [2, 3] } });

const checks = [];
const check = (name, ok, detail = "") => { checks.push([name, ok, detail]); say(`${ok ? "pass" : "FAIL"} ${name} ${detail}`); };

// --- scenario 1: pool + sticky -------------------------------------------
start(1, "t1");
await waitFor(() => replies(1).length === 1 && replies(1)[0].result?.providerThreadId, 20000, "t1 start");
const t1Ptid = replies(1)[0].result.providerThreadId;
turn(2, "t1", "hello");
await waitFor(() => boundaries("t1").length === 1, 20000, "t1 turn");
check("pool/first-spawn-account", news("a1").length === 1 && prompts("a1").length === 1, `a1 new=${news("a1").length} prompt=${prompts("a1").length}`);
check("pool/args-gemini-dir", transcriptLines().some((l) => l.method === "session/new"), "");
check("pool/sticky-ledger", ledger().conversations[t1Ptid] === "a1", JSON.stringify(ledger().conversations));
check("pool/usage-delta", usages("t1").length === 1 && usages("t1")[0].last.totalTokens > 0, JSON.stringify(usages("t1").map((u) => u.last.totalTokens)));
check("pool/context-window-delta", cws("t1").length === 1 && cws("t1")[0].used === 140 && cws("t1")[0].estimated === true, JSON.stringify(cws("t1")));

// --- scenario 2: quota rotation with handoff ------------------------------
turn(3, "t1", "[[quota]] continue the work");
await waitFor(() => boundaries("t1").length === 2 && boundaries("t1")[1].status === "completed", 30000, "rotation completes");
const handoffPrompt = (prompts("a2")[0]?.params?.prompt ?? []).map((b) => b.text ?? "").join("\n");
check("rotation/suppressed-error", perrors("t1").length === 0 && errors("t1").length === 0, `perr=${perrors("t1").length} err=${errors("t1").length}`);
check("rotation/one-open-two-boundaries", opens("t1").length === 2 && boundaries("t1").length === 2, `open=${opens("t1").length} b=${boundaries("t1").length}`);
check("rotation/session-replaced", replaced("t1").some((m) => m.params.contextLost === true), "");
check("rotation/handoff-prompt", handoffPrompt.includes("[quota-rotation-handoff]") && handoffPrompt.includes("continue the work"), handoffPrompt.slice(0, 90));
check("rotation/cooldown-recorded", (ledger().accounts.a1?.cooldownUntilMs ?? 0) > Date.now(), "");
check("rotation/new-conv-a2", loads("a2").length === 0 && prompts("a2").length >= 1, `a2 loads=${loads("a2").length}`);

// --- scenario 3: whole pool cooled → rateLimits + provider-retry path -----
cool("a2", 60_000); cool("a3", 60_000); cool("a4", 60_000);
setControl({ modeByLabel: { a2: "quota-always" } });
turn(4, "t1", "another turn");
await waitFor(() => perrors("t1").length >= 1, 20000, "whole-pool error");
await sleep(300);
const errDelta = perrors("t1")[0];
check("cool/errorInfo-injected", errDelta.errorInfo?.category === "rate-limit" && errDelta.errorInfo?.httpStatusCode === 429, JSON.stringify(errDelta.errorInfo));
check("cool/rateLimits-blocked", rateLimits("t1").some((d) => d.rateLimits.status === "blocked" && d.rateLimits.windows[0].resetsAtMs > 0), "");
setControl({ modeByLabel: {} });

// --- scenario 4: turn/start on cooled session → rotates then runs ---------
// a2 just failed → cooled by the automaton itself. Ledger cooldowns for a1 already set.
const l4 = ledger(); // make sure a1 cooled too
if ((l4.accounts.a1?.cooldownUntilMs ?? 0) < Date.now()) cool("a1", 60_000);
cool("a3", 200); cool("a4", 200);
await sleep(400); // a3,a4 revive
turn(5, "t1", "after provider retry");
await waitFor(() => boundaries("t1").length >= 3 && boundaries("t1").at(-1).status === "completed", 40000, "post-cooldown turn");
check("cool/retry-rotates-to-revived", news("a3").length + news("a4").length >= 1, `a3=${news("a3").length} a4=${news("a4").length}`);

// --- scenario 5: resume on cooled owner → sibling + handoff on first turn --
const t1bPtid = "fake-old-conv";
cool("a1", 60_000); cool("a2", 60_000); cool("a3", 60_000);
// a4 free
{
  const l = ledger();
  l.conversations[t1bPtid] = "a1";
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(l));
}
resume(10, "t2", t1bPtid);
await waitFor(() => replies(10).length === 1, 20000, "t2 resume");
check("resume/sibling-start", news("a4").length >= 1 && loads("a1").length === 0, `a4new=${news("a4").length} a1load=${loads("a1").length}`);
check("resume/replaced-announced", replaced("t2").some((m) => m.params.contextLost === true), "");
turn(11, "t2", "first prompt after resume");
await waitFor(() => boundaries("t2").length === 1, 20000, "t2 first turn");
check("resume/handoff-first-turn", ptxt0(prompts("a4")[0]).includes("[quota-rotation-handoff]"), "");

// --- scenario 6: compact fallback 2 stages ---------------------------------
setControl({ compactMode: "fail" });
send({ jsonrpc: "2.0", id: 20, method: "turn/start", params: { threadId: "t2", providerThreadId: ptidOf("t2"), input: [{ type: "text", text: "/compact", mentions: [{ start: 0, end: 8, resource: { kind: "command", trigger: "/", name: "compact", source: "command", origin: "builtin", label: "/compact", argumentHint: null } }] }], clientRequestId: creq(), options } });
const ptxt = (p) => (p.params.prompt ?? []).map((b) => b.text ?? "").join("\n");
await waitFor(() => prompts("a4").filter((p) => ptxt(p).includes("[compaction-fallback]")).length >= 1, 30000, "summary prompt");
await waitFor(() => prompts("a4").filter((p) => ptxt(p).includes("[compaction-handoff]")).length >= 1, 30000, "seed prompt");
await waitFor(() => boundaries("t2").length >= 3, 30000, "compact boundaries");
const seedText = ptxt(prompts("a4").filter((p) => ptxt(p).includes("[compaction-handoff]"))[0]);
check("compact/summary-then-seed", seedText?.includes("answer to"), seedText?.slice(0, 80));
check("compact/fresh-conversation", news("a4").length >= 2, `a4new=${news("a4").length}`);
setControl({ compactMode: "ok" });

// --- scenario 7: artifact guardrail + nudge --------------------------------
turn(30, "t2", "[[artifact]] write the file");
await waitFor(() => prompts("a4").filter((p) => ptxt(p).includes("ArtifactMetadata")).length >= 1, 30000, "nudge turn");
check("artifact/nudge-turn", true, "");

// --- scenario 8: hanging interaction resolved on release -------------------
// Under "full" the bridge auto-allows; a runtime request needs accept-edits.
const editOptions = { ...options, permissionMode: "accept-edits", permissionScope: "workspace", approvalReviewer: "user", permissionEscalation: "ask" };
threadReqIds.t5 = 40;
send({ jsonrpc: "2.0", id: 40, method: "thread/start", params: { threadId: "t5", cwd: workspace, options: editOptions, instructionMode: "append" } });
await waitFor(() => replies(40).length === 1, 20000, "t5 start");
send({ jsonrpc: "2.0", id: 41, method: "turn/start", params: { threadId: "t5", providerThreadId: ptidOf("t5"), input: [{ type: "text", text: "[[askperm]] do the thing", mentions: [] }], clientRequestId: creq(), options: editOptions } });
const sawInteraction = () => messages.some((m) => m.method === "interaction/request" && m.params?.threadId === "t5");
await waitFor(sawInteraction, 20000, "interaction request");
stop(42, "t5", "release");
await sleep(500);
const lifecycle = messages.find((m) =>
  m.method === "provider/raw" &&
  m.params?.raw?.method === "system/interaction/lifecycle" &&
  m.params?.raw?.params?.threadId === "t5" &&
  m.params?.raw?.params?.interaction?.status === "cancelled");
check("interaction/resolved-on-release", lifecycle !== undefined,
  JSON.stringify(messages.slice(-15).map((m) => (m.method ?? `id:${m.id}`))));

// --- scenario 9: two parallel threads on one account -----------------------
{
  const l = ledger();
  for (const a of ["a1", "a2", "a3", "a4"]) l.accounts[a].cooldownUntilMs = 0;
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(l));
}
start(50, "t3");
await waitFor(() => replies(50).length === 1, 20000, "t3 start");
start(51, "t4");
await waitFor(() => replies(51).length === 1, 20000, "t4 start");
setControl({ modeByLabel: { a3: "quota-once", a4: "quota-once" } });
const t3acct = Object.entries(ledger().conversations).find(([, v]) => replies(50)[0].result.providerThreadId === undefined) ? null : ledger().conversations[replies(50)[0].result.providerThreadId];
turn(52, "t3", "[[quota]] fails once");
turn(53, "t4", "regular work");
await waitFor(() => boundaries("t4").length >= 1 && boundaries("t4")[0].status === "completed", 30000, "t4 unaffected");
await waitFor(() => boundaries("t3").length >= 1, 30000, "t3 settles");
check("parallel/t4-unbroken", boundaries("t4")[0].status === "completed", `t3acct=${t3acct}`);
setControl({ modeByLabel: {} });

// --- scenario: auth-dead — live turn parks + rotates -----------------------
// a) live turn hits auth_required → account parked, turn replayed on sibling.
setControl({ modeByLabel: {}, compactMode: "ok" });
threadReqIds.t6 = 150;
start(150, "t6");
await waitFor(() => replies(150).length === 1 && replies(150)[0].result?.providerThreadId, 20000, "t6 start");
const t6ptid = replies(150)[0].result.providerThreadId;
const t6acct = ledger().conversations[t6ptid];
setControl({ modeByLabel: { [t6acct]: "auth-dead" } });
turn(151, "t6", "still here?");
await waitFor(() => boundaries("t6").length >= 1 && boundaries("t6").at(-1).status === "completed", 40000, "t6 rotated turn");
check("authdead/parked", ledger().accounts[t6acct]?.parkedReason === "auth-dead" && (ledger().accounts[t6acct]?.cooldownUntilMs ?? 0) > Date.now() + 3_600_000, `acct=${t6acct} pr=${ledger().accounts[t6acct]?.parkedReason}`);
check("authdead/turn-replayed", boundaries("t6").at(-1).status === "completed", "");
check("authdead/replaced-contextLost", replaced("t6").some((m) => m.params.contextLost === true), "");
check("authdead/no-rateLimits-no-perr", rateLimits("t6").length === 0 && perrors("t6").length === 0, `rl=${rateLimits("t6").length} perr=${perrors("t6").length}`);

// b) resume pinned to the parked account → same rotation.
const deadPtid = "fake-dead-conv";
{
  const l = ledger();
  l.conversations[deadPtid] = t6acct;
  writeFileSync(join(root, "accounts-state.json"), JSON.stringify(l));
}
const newsBefore = Object.fromEntries(["a1", "a2", "a3", "a4"].map((h) => [h, news(h).length]));
threadReqIds.t7 = 160;
resume(160, "t7", deadPtid);
await waitFor(() => replies(160).length === 1, 20000, "t7 resume");
await waitFor(() => ["a1", "a2", "a3", "a4"].some((h) => h !== t6acct && news(h).length > newsBefore[h]), 20000, "t7 sibling start");
check("authdead/resume-sibling", true, "");

// d2) resume on a LIVE owner → generic bridge issues a real session/load
// (makes subagents/session-load-injected a non-vacuous check).
threadReqIds.t1r = 165;
resume(165, "t1r", ptidOf("t1"));
await waitFor(() => replies(165).length === 1, 20000, "t1r live resume");
await waitFor(() => transcriptLines().some((l) => l.method === "session/load"), 20000, "session/load reaches fake");

// e) central bb setting re-enable: providerOptions.providerSubagentsEnabled=true
// must flip the shim env and the stamped settings.json for that session only.
threadReqIds.t9 = 180;
send({ jsonrpc: "2.0", id: 180, method: "thread/start", params: { threadId: "t9", cwd: workspace, options: { ...options, providerOptions: { providerSubagentsEnabled: true } }, instructionMode: "append" } });
await waitFor(() => replies(180).length === 1, 20000, "t9 start");
const t9acct = ledger().conversations[ptidOf("t9")];
// Read the stamp now — the all-dead phase re-stamps every account as disabled.
const t9Settings = (() => { try { return JSON.parse(readFileSync(join(root, "accounts", t9acct, ".gemini", "settings.json"), "utf8")); } catch { return {}; } })();
const t9news = transcriptLines().filter((l) => l.method === "session/new" && l.home === t9acct);
const t9envOn = t9news.some((l) => l.__env?.AGY_DISABLE_SUBAGENTS === "0");

// c) every account dead → honest pool-exhausted fail, no rotation spam.
setControl({ modeByLabel: { a1: "auth-dead", a2: "auth-dead", a3: "auth-dead", a4: "auth-dead" } });
threadReqIds.t8 = 170;
start(170, "t8");
await waitFor(() => replies(170).length === 1, 20000, "t8 start");
turn(171, "t8", "everyone is dead");
await waitFor(() => boundaries("t8").length >= 1 && boundaries("t8").at(-1).status === "failed", 60000, "t8 pool fail");
const t8last = boundaries("t8").at(-1);
const t8err = t8last?.error?.message ?? perrors("t8").at(-1)?.message ?? "";
check("authdead/pool-exhausted-honest", t8last?.status === "failed" && /re-authenticate|lost its google sign-in/iu.test(t8err), t8err.slice(0, 120));
check("authdead/all-parked", ["a1", "a2", "a3", "a4"].filter((h) => ledger().accounts[h]?.parkedReason === "auth-dead").length >= 3, JSON.stringify(Object.fromEntries(Object.entries(ledger().accounts).map(([k, v]) => [k, v.parkedReason ?? null]))));
check("authdead/no-rateLimits-on-fail", rateLimits("t8").length === 0, "");
setControl({ modeByLabel: {} });

// --- shim materialization ---------------------------------------------------
check("shim/materialized", existsSync(join(root, "acp-shim.mjs")) && readFileSync(join(root, "acp-shim.mjs"), "utf8").includes("NDJSON relay"), "");
check("shim/argv-embedded-path", !transcriptLines().some((l) => JSON.stringify(l).includes("/src/acp-shim.mjs")), "");

// --- native subagents disabled ----------------------------------------------
const sessionReqs = (m) => transcriptLines().filter((l) => l.method === m);
const hasDisabled = (l) => Array.isArray(l.params?.disableBuiltInTools) && l.params.disableBuiltInTools.includes("invoke_subagent");
// Injection happens iff the session resolved subagents OFF (env !== "0"):
// coupling the env record to the injected field is the real invariant.
const envOnLine = (l) => l.__env?.AGY_DISABLE_SUBAGENTS === "0";
check("subagents/session-new-injected", sessionReqs("session/new").length > 0 && sessionReqs("session/new").every((l) => hasDisabled(l) === !envOnLine(l)), `news=${sessionReqs("session/new").length}`);
check("subagents/session-load-injected", sessionReqs("session/load").length > 0 && sessionReqs("session/load").every(hasDisabled), `loads=${sessionReqs("session/load").length}`);
const a1Settings = (() => { try { return JSON.parse(readFileSync(join(root, "accounts", "a1", ".gemini", "settings.json"), "utf8")); } catch { return {}; } })();
check("subagents/settings-stamped", a1Settings.antigravityConfig?.subagentsConfig?.enabled === false && a1Settings.antigravity_config?.subagents_config?.enabled === false, JSON.stringify(a1Settings).slice(0, 200));
check("subagents/disabled-env-default", sessionReqs("session/new").length > 0 && sessionReqs("session/new").every((l) => (l.__env?.AGY_DISABLE_SUBAGENTS ?? "1") === "1" || l.home === t9acct), "");
check("subagents/reenabled-env", t9envOn, `t9acct=${t9acct} t9news=${t9news.length}`);
check("subagents/reenabled-settings", t9Settings.antigravityConfig?.subagentsConfig?.enabled === true && t9Settings.antigravityConfig?.boostCommandDisabled === false, JSON.stringify(t9Settings.antigravityConfig));

// --- model/list ------------------------------------------------------------
process.env.AGY_FAKE_MODELS_OUT = "";
send({ jsonrpc: "2.0", id: 90, method: "model/list", params: {} });
await waitFor(() => replies(90).length === 1, 20000, "model list");
check("models/answered", replies(90)[0].result?.models?.length >= 1, JSON.stringify(replies(90)[0].result?.models?.map((m) => m.id)));
const ladderModel = (replies(90)[0].result?.models ?? []).find((m) => m.id === "fake-model") ?? replies(90)[0].result?.models?.[0];
const ladderEfforts = (ladderModel?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
check("models/effort-ladder", ladderEfforts.includes("low") && ladderEfforts.includes("medium") && ladderEfforts.includes("high"), JSON.stringify(ladderEfforts));

process.stdout.write = originalWrite;
say(`\n${checks.filter(([, ok]) => ok).length}/${checks.length} passed`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
