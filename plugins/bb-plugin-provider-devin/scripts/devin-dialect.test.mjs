// node --test scripts/devin-dialect.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";

const code = readFileSync(new URL("../src/devin-dialect.js", import.meta.url), "utf8");
const delegationPresentation = (args) => ({
  label: { pending: "Running subagent", completed: "Subagent finished" },
  title: args.label,
  ...(args.detail === undefined ? {} : { detail: args.detail }),
});
const { devinClassifyToolCall, DEVIN_ACP_DIALECT } = new Function(
  "z",
  "delegationPresentation",
  `${code}\nreturn { devinClassifyToolCall, DEVIN_ACP_DIALECT };`,
)(z, delegationPresentation);

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
