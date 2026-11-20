// plugins/bb-plugin-orchestrator/tests/spec-check.test.ts
// Unit tests for delta-based codebase reference verification (§31.6, r34.2)

import test from "node:test";
import assert from "node:assert/strict";
import { verifySpecReferences, parseSpecEntities } from "../src/spec-check.js";
import type { CmdRunner } from "../src/cmd.js";
import type { TaskQueueRow } from "../src/store.js";

const DUMMY_TASK: TaskQueueRow = {
  id: 1,
  task_key: "PLUG-315",
  project_id: "proj_1",
  coordinator_thread_id: "thr_coord",
  branch: "bb/plug-315",
  node: "spec",
  status: "running",
  route: "feature",
  level: "complex",
  priority: 10,
  created_at: 1000,
  updated_at: 1000,
  payload_json: "{}",
} as unknown as TaskQueueRow;

test("§31.6 delta spec-check: spec with old unknown names + added line with valid symbol -> OK", async () => {
  // Simulating a diff where only the new line was added. Old lines in docs with 27 missing names are NOT in the diff.
  const diffOutput = `diff --git a/docs/specs/orchestrator.md b/docs/specs/orchestrator.md
--- a/docs/specs/orchestrator.md
+++ b/docs/specs/orchestrator.md
@@ -100,0 +101 @@
+Функция \`verifyExistingSymbol\` проверяет существующие ссылки.
`;

  const cmd: CmdRunner = {
    run: async (file, args) => {
      if (args[0] === "diff") {
        return { exitCode: 0, stdout: diffOutput, stderr: "" };
      }
      if (args[0] === "grep") {
        // verifyExistingSymbol exists in codebase
        const symbol = args[4];
        if (symbol === "verifyExistingSymbol") {
          return { exitCode: 0, stdout: "src/existing.ts: export function verifyExistingSymbol()", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "cat-file") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const res = await verifySpecReferences({ cmd, repoRoot: "/fake/repo" }, DUMMY_TASK, "specSha", "origin/main");
  assert.equal(res.valid, true);
  assert.equal(res.notRun, undefined);
  assert.equal(res.missingReferences, undefined);
});

test("§31.6 delta spec-check: spec with added line with invalid symbol -> FAIL", async () => {
  const diffOutput = `diff --git a/docs/specs/orchestrator.md b/docs/specs/orchestrator.md
--- a/docs/specs/orchestrator.md
+++ b/docs/specs/orchestrator.md
@@ -100,0 +101 @@
+Функция \`fabricatedNonExistentSymbol\` отсутствует в кодовой базе.
`;

  const cmd: CmdRunner = {
    run: async (file, args) => {
      if (args[0] === "diff") {
        return { exitCode: 0, stdout: diffOutput, stderr: "" };
      }
      if (args[0] === "grep") {
        // symbol does not exist in codebase
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "cat-file") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const res = await verifySpecReferences({ cmd, repoRoot: "/fake/repo" }, DUMMY_TASK, "specSha", "origin/main");
  assert.equal(res.valid, false);
  assert.equal(res.notRun, false);
  assert.ok(res.missingReferences?.includes("symbol:fabricatedNonExistentSymbol"));
  assert.ok(res.reason?.includes("invalid-codebase-reference"));
});

test("§31.6 delta spec-check: spec with added line with [new] -> OK", async () => {
  const diffOutput = `diff --git a/docs/specs/orchestrator.md b/docs/specs/orchestrator.md
--- a/docs/specs/orchestrator.md
+++ b/docs/specs/orchestrator.md
@@ -100,0 +101 @@
+Новая функция \`brandNewFeatureSymbol\` [new] будет реализована в коде.
`;

  const cmd: CmdRunner = {
    run: async (file, args) => {
      if (args[0] === "diff") {
        return { exitCode: 0, stdout: diffOutput, stderr: "" };
      }
      if (args[0] === "grep") {
        // If grep was called on a [new] symbol, it would fail, but [new] symbols are skipped
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const res = await verifySpecReferences({ cmd, repoRoot: "/fake/repo" }, DUMMY_TASK, "specSha", "origin/main");
  assert.equal(res.valid, true);
  assert.equal(res.notRun, undefined);
});

test("§31.6 delta spec-check: no docs added lines -> valid: true", async () => {
  const cmd: CmdRunner = {
    run: async (file, args) => {
      if (args[0] === "diff") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const res = await verifySpecReferences({ cmd, repoRoot: "/fake/repo" }, DUMMY_TASK, "specSha", "origin/main");
  assert.equal(res.valid, true);
});

test("§31.6 delta spec-check: git diff failure -> notRun: true", async () => {
  const cmd: CmdRunner = {
    run: async (file, args) => {
      if (args[0] === "diff") {
        return { exitCode: 128, stdout: "", stderr: "fatal: bad revision" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  const res = await verifySpecReferences({ cmd, repoRoot: "/fake/repo" }, DUMMY_TASK, "specSha", "origin/main");
  assert.equal(res.valid, false);
  assert.equal(res.notRun, true);
  assert.ok(res.reason?.includes("spec-not-run"));
});
