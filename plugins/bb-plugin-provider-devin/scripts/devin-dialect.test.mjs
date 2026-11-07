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
const { devinClassifyToolCall, DEVIN_ACP_DIALECT, persistDevinBbInstructions } = new Function(
  "z",
  "delegationPresentation",
  "fs",
  "os",
  "path2",
  `${code}\nreturn { devinClassifyToolCall, DEVIN_ACP_DIALECT, persistDevinBbInstructions };`,
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
