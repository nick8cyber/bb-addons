// node --test scripts/devin-dialect.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { promises as fsPromises, mkdtempSync, readFileSync as readSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const fakeHome = mkdtempSync(path.join(tmpdir(), "devin-dialect-"));
const fakeOs = { homedir: () => fakeHome };

const code = readFileSync(new URL("../src/devin-dialect.js", import.meta.url), "utf8");
const delegationPresentation = (args) => ({
  label: { pending: "Running subagent", completed: "Subagent finished" },
  title: args.label,
  ...(args.detail === undefined ? {} : { detail: args.detail }),
});
const { devinClassifyToolCall, DEVIN_ACP_DIALECT, persistDevinBbInstructions, isBbSystemNotice, applyDevinAcpSessionMode } = new Function(
  "z",
  "delegationPresentation",
  "fs",
  "os",
  "path2",
  `${code}\nreturn { devinClassifyToolCall, DEVIN_ACP_DIALECT, persistDevinBbInstructions, isBbSystemNotice, applyDevinAcpSessionMode };`,
)(z, delegationPresentation, fsPromises, fakeOs, path);

// Реальное событие из bb (<thread> seq 2346), до выключения субагентов.
const backgroundSubagent = {
  sessionUpdate: "tool_call",
  toolCallId: "da222f19db-i1197",
  title: "Ran general subagent Tracker: PLUG-122/124/125",
  status: "pending",
  rawInput: {
    title: "Tracker: PLUG-122/124/125",
    task: "You are a monitoring agent ...",
    profile: "subagent_general",
    is_background: true,
  },
};

test("background subagent -> delegation", () => {
  const r = devinClassifyToolCall(backgroundSubagent);
  assert.deepEqual(r.item, {
    type: "delegation",
    childRef: "da222f19db-i1197",
    label: "Tracker: PLUG-122/124/125",
    background: true,
  });
  assert.equal(r.presentation.detail, "general · в фоне");
});

test("foreground explore subagent -> delegation", () => {
  const r = devinClassifyToolCall({
    ...backgroundSubagent,
    toolCallId: "x1",
    title: "Ran explore subagent Find auth",
    rawInput: { title: "Find auth", task: "find", profile: "subagent_explore", is_background: false },
  });
  assert.equal(r.item.background, false);
  assert.equal(r.item.label, "Find auth");
  assert.equal(r.presentation.detail, "explore");
});

test("read shell / exec / other tools stay generic", () => {
  assert.equal(devinClassifyToolCall({ toolCallId: "a", title: "Read shell", rawInput: { shell_id: "c8", timeout: 30000 } }), undefined);
  assert.equal(devinClassifyToolCall({ toolCallId: "b", title: "Run command", rawInput: { command: "ls" } }), undefined);
  assert.equal(devinClassifyToolCall({ toolCallId: "c", title: "x", rawInput: undefined }), undefined);
  // поле task без профиля и без слова subagent — не субагент
  assert.equal(devinClassifyToolCall({ toolCallId: "d", title: "Todo", rawInput: { task: "write tests" } }), undefined);
});

test("dialect id", () => {
  assert.equal(DEVIN_ACP_DIALECT.id, "devin");
  assert.equal(typeof DEVIN_ACP_DIALECT.classifyToolCall, "function");
});

test("bb instructions persisted per thread, 0600, junk ids ignored", async () => {
  persistDevinBbInstructions("thr_abc123", "RULES-TEXT");
  persistDevinBbInstructions("../evil", "X");
  persistDevinBbInstructions("thr_def456", undefined);
  await new Promise((r) => setTimeout(r, 100));
  const dir = path.join(fakeHome, ".local", "state", "bb-devin", "instructions");
  const file = path.join(dir, "thr_abc123.md");
  assert.equal(readSync(file, "utf8"), "RULES-TEXT");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(dir), ["thr_abc123.md"]);
});

test("bb system and orchestrator notices are soft, owner and agent messages are not", () => {
  const t = (text) => [{ type: "text", text }];
  assert.equal(isBbSystemNotice(t("[bb system]\n\n@thread:thr_a completed:\n\nok")), true);
  assert.equal(isBbSystemNotice(t("[bb system]\n\n@thread:thr_a is now a child of this thread.")), true);
  assert.equal(isBbSystemNotice(t("[orchestrator]\n\nстатус волны: 2/3")), true);
  assert.equal(isBbSystemNotice(t("[bb message from thread:thr_x]\n\nстоп")), false);
  assert.equal(isBbSystemNotice(t("стоп, не деплой")), false);
  assert.equal(isBbSystemNotice(t("не [orchestrator] в начале")), false);
  assert.equal(isBbSystemNotice([{ type: "image", url: "x" }]), false);
  assert.equal(isBbSystemNotice(undefined), false);
});

const acpModeOption = {
  id: "mode",
  type: "select",
  options: ["accept-edits", "smart", "ask", "plan", "bypass"].map((value) => ({ value })),
};
function fakeAcpConnection(requests, fail) {
  return {
    request({ method, params }) {
      requests.push({ method, params });
      return fail ? Promise.reject(new Error("set_config_option rejected")) : Promise.resolve(null);
    },
  };
}
function captureStderr(fn) {
  const warnings = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    warnings.push(String(chunk));
    return true;
  };
  return fn().finally(() => {
    process.stderr.write = original;
  }).then((result) => ({ result, warnings }));
}

test("permissionMode maps to ACP session mode", async () => {
  for (const [permissionMode, mode] of [["full", "bypass"], ["accept-edits", "accept-edits"], ["auto", "smart"]]) {
    const requests = [];
    const { warnings } = await captureStderr(() => applyDevinAcpSessionMode({
      connection: fakeAcpConnection(requests, false),
      sessionId: "s1",
      permissionMode,
      configOptions: [acpModeOption],
      agentLabel: "devin",
    }));
    assert.deepEqual(requests, [{
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "mode", value: mode },
    }]);
    assert.deepEqual(warnings, []);
  }
});

test("mode option found by category too", async () => {
  const requests = [];
  await applyDevinAcpSessionMode({
    connection: fakeAcpConnection(requests, false),
    sessionId: "s1",
    permissionMode: "full",
    configOptions: [{ id: "m1", category: "mode", type: "select", options: acpModeOption.options }],
    agentLabel: "devin",
  });
  assert.equal(requests[0].params.configId, "m1");
  assert.equal(requests[0].params.value, "bypass");
});

test("no mode option or missing value -> one warning, no request", async () => {
  for (const configOptions of [
    [],
    [{ id: "mode", type: "select", options: [{ value: "smart" }] }],
    [{ id: "model", category: "model", type: "select", options: [{ value: "bypass" }] }],
  ]) {
    const requests = [];
    const { warnings } = await captureStderr(() => applyDevinAcpSessionMode({
      connection: fakeAcpConnection(requests, false),
      sessionId: "s1",
      permissionMode: "full",
      configOptions,
      agentLabel: "devin",
    }));
    assert.deepEqual(requests, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /does not offer session mode "bypass"/);
  }
});

test("set_config_option error is fail-open: warning, no throw", async () => {
  const requests = [];
  const { warnings } = await captureStderr(() => applyDevinAcpSessionMode({
    connection: fakeAcpConnection(requests, true),
    sessionId: "s1",
    permissionMode: "full",
    configOptions: [acpModeOption],
    agentLabel: "devin",
  }));
  assert.equal(requests.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to set ACP session mode "bypass"/);
});
