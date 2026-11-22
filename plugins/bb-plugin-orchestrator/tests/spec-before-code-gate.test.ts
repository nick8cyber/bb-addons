// plugins/bb-plugin-orchestrator/tests/spec-before-code-gate.test.ts
// Acceptance tests for spec-before-code gate (§31.9, orchestrator-release §2, ADR-0032)

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp.js";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { CmdRunner } from "../src/cmd.js";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import { parsePolicy } from "../src/policy.js";
import { createPlugin } from "../server.js";
import {
  verifySpecBeforeCodeGate,
  verifyReleaseDocumentsGate,
  resolveTaskSpecContract,
  type SpecContract,
} from "../src/spec-gate.js";
import { runRunQueue } from "../src/workgraph.js";
import { runDelegate, dispatchToRoute } from "../src/delegate.js";
import { OrchestratorError } from "../src/errors.js";

const POLICY_TEXT = JSON.stringify({
  version: 1,
  limits: { maxActive: 5 },
  levels: {
    simple: { chain: ["simple", "simple-fallback"] },
    complex: { chain: ["complex", "complex-reserve-1", "complex-reserve-2"] },
    review: { chain: ["review-route"] },
  },
  routes: {
    simple: { preset: "simple", provider: "acp-opencode" },
    "simple-fallback": { preset: "simple-fallback", provider: "agy" },
    complex: { preset: "complex", provider: "acp-devin" },
    "complex-reserve-1": { preset: "reserve-1", provider: "acp-devin" },
    "complex-reserve-2": { preset: "reserve-2", provider: "agy" },
    "review-route": { preset: "auditor", provider: "acp-devin" },
  },
});

const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

function fakeCli(respond?: (args: string[]) => BbCliResult | undefined): {
  cli: BbCli;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    cli: {
      run: async (args) => {
        calls.push(args);
        const custom = respond?.(args);
        if (custom) return custom;
        const key = args.join(" ");
        if (key.startsWith("tasks preset list"))
          return ok(
            JSON.stringify({
              presets: [
                { name: "simple", id: "p1" },
                { name: "simple-fallback", id: "p2" },
                { name: "complex", id: "p3" },
                { name: "reserve-1", id: "p4" },
                { name: "reserve-2", id: "p5" },
                { name: "auditor", id: "p6" },
              ],
            }),
          );
        if (key.startsWith("tasks preset show"))
          return ok(
            JSON.stringify({
              preset: {
                providerId: "p",
                modelId: "m1",
                reasoningLevel: "medium",
                permissionMode: "auto",
                environmentKind: "project-default",
              },
            }),
          );
        if (key.startsWith("tasks show"))
          return ok(
            JSON.stringify({
              task: {
                id: "task-1",
                key: args[2] ?? "FAVORITE-1",
                title: "Favorite Models Feature",
                status: "in_progress",
              },
              project: { name: "p", linkedBbProjectId: "proj_bb" },
              subtasks: [],
              attachments: [],
              comments: [],
            }),
          );
        if (key.startsWith("thread show"))
          return ok(
            JSON.stringify({
              thread: {
                parentThreadId: "thr_coord",
                parentNotifications: "auto",
                visibility: "hidden",
              },
            }),
          );
        if (key.startsWith("provider-retry status"))
          return ok(JSON.stringify({ retries: [] }));
        return ok();
      },
    },
  };
}

function initGitRepo(dir: string): {
  run: (args: string[]) => string;
  cmd: CmdRunner;
} {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run(["init", "-b", "main"]);
  run(["config", "user.name", "Tester"]);
  run(["config", "user.email", "test@test.local"]);
  run(["commit", "--allow-empty", "-m", "initial"]);

  const cmd: CmdRunner = {
    run: async (file, args, opts) => {
      try {
        const out = execFileSync(file, args, {
          cwd: opts?.cwd ?? dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { exitCode: 0, stdout: out, stderr: "" };
      } catch (e: any) {
        return {
          exitCode: e.status ?? 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
        };
      }
    },
  };

  return { run, cmd };
}

// ── 1. Favorite Models incident reproduction: CLI, RPC, run-queue in shadow ────

test("§31.9 Favorite Models: CLI bb orchestrator delegate in shadow mode rejects with spec-gate-violation and 0 spawns", async () => {
  const spawnedThreads: any[] = [];
  const fake = fakeCli();
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-spec-fav-cli-"),
    settings: {
      policy: POLICY_TEXT,
      language: "ru",
      workGraph: "shadow",
    },
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "thr_coord" }),
        spawn: async (args) => {
          spawnedThreads.push(args);
          return { threadId: "thr_spawned" };
        },
      },
    },
  });

  await createPlugin(host.bb, { bbCli: fake.cli });

  const res = await host.harness.runCli(
    ["delegate", "FAVORITE-1", "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );

  // Must fail
  assert.notEqual(res.exitCode, 0, "CLI must reject without spec");
  assert.match(
    res.stderr + res.stdout,
    /spec-gate-violation/,
    "Error output must specify spec-gate-violation",
  );
  // Verify 0 executor threads spawned
  assert.equal(spawnedThreads.length, 0, "0 executor threads must be spawned");
});

test("§31.9 Favorite Models: RPC orchestrator_delegate tool in shadow mode rejects with spec-gate-violation and 0 spawns", async () => {
  const spawnedThreads: any[] = [];
  const fake = fakeCli();
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-spec-fav-rpc-"),
    settings: {
      policy: POLICY_TEXT,
      language: "ru",
      workGraph: "shadow",
    },
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "thr_coord" }),
        spawn: async (args) => {
          spawnedThreads.push(args);
          return { threadId: "thr_spawned" };
        },
      },
    },
  });

  await createPlugin(host.bb, { bbCli: fake.cli });

  const rawRes = (await host.harness.callAgentTool(
    "orchestrator_delegate",
    { taskKey: "FAVORITE-1", level: "simple" },
    { threadId: "thr_coord" },
  )) as string;
  const parsed = JSON.parse(rawRes);

  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "spec-gate-violation");
  assert.match(parsed.error.message, /spec-gate-violation/);
  assert.equal(spawnedThreads.length, 0, "0 executor threads must be spawned");
});

test("§31.9 Favorite Models: run-queue in shadow mode rejects with spec-gate-violation and 0 spawns", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  // Enqueue task on simple route (transitions start -> code on queue_take in auto mode)
  store.insertTask({
    taskKey: "FAVORITE-1",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });

  const repoDir = makeTempDir("orch-spec-rq-");
  const { cmd } = initGitRepo(repoDir);

  const dispatchedNodes: string[] = [];
  const runQueueDeps = {
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "shadow" as const,
    policy: parsePolicy(POLICY_TEXT).policy,
    dispatchNode: async (task: any, node: any) => {
      dispatchedNodes.push(node);
      return { ok: true };
    },
  };

  // Run run-queue in shadow mode without spec contract -> must reject with spec-gate-violation
  await assert.rejects(
    async () => {
      await runRunQueue(runQueueDeps);
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  // Verify shadow_eval recorded would_reject
  const task = store.getTask("FAVORITE-1")!;
  const payload = JSON.parse(task.payload ?? "{}");
  assert.equal(payload.shadow_eval?.would_reject, "spec-gate-violation");
  assert.equal(dispatchedNodes.length, 0, "0 nodes must be dispatched");
});

// ── 2. Simple level does not bypass spec gate ──────────────────────────────────

test("§31.9 Simple level does not bypass spec gate", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-simple-");
  const { cmd } = initGitRepo(repoDir);

  // Calling verifySpecBeforeCodeGate for level: simple with no contract
  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "SIMPLE-1",
        level: "simple",
        role: "executor",
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
});

// ── 3. Fallback route chain: does not spawn on spec-gate-violation ─────────────

test("§31.9 Fallback route chain: neither primary nor fallback routes spawn on spec-gate-violation", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const spawnedThreads: any[] = [];
  const repoDir = makeTempDir("orch-spec-fallback-");
  const { cmd } = initGitRepo(repoDir);
  const policy = parsePolicy(POLICY_TEXT);

  const row = store.insert({
    taskKey: "CHAIN-1",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    level: "complex",
    route: "complex",
    preset: "complex",
    provider: "acp-devin",
    round: 1,
    continueFrom: null,
    explicitRoute: false,
    noCode: false,
    attach: null,
  });

  const dispatchDeps = {
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "shadow" as const,
    policy: () => policy.policy,
    bbCli: fakeCli().cli,
    threads: {
      spawn: async (args: any) => {
        spawnedThreads.push(args);
        return { threadId: "thr_sub" };
      },
      updatePluginMetadata: async () => ({}),
      get: async () => ({ status: "running" }),
      stop: async () => ({}),
      update: async () => ({}),
      list: async () => [],
    } as any,
    primaryHostId: async () => "host1",
  };

  await assert.rejects(
    async () => {
      await dispatchToRoute(row, {}, dispatchDeps);
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  // Verify 0 spawns
  assert.equal(spawnedThreads.length, 0, "No primary or fallback thread should be spawned");
  // Verify row route did not advance to reserve-1 or reserve-2
  const updatedRow = store.get(row.id)!;
  assert.equal(updatedRow.route, "complex", "Route must not advance to fallbacks");
});

// ── 4. Foreign / unreachable SHA ──────────────────────────────────────────────

test("§31.9 Foreign SHA: rejects when specSha is not in git history", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-foreign-");
  const { cmd } = initGitRepo(repoDir);

  const foreignContract: SpecContract = {
    kind: "behavior_change",
    specPath: "docs/specs/my-spec.md",
    specSha: "0123456789abcdef0123456789abcdef01234567", // Non-existent foreign commit
  };

  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "FOREIGN-1",
        level: "complex",
        role: "executor",
        contract: foreignContract,
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /не найден в репозитории/);
      return true;
    },
  );
});

// ── 5. Architectural change without ADR ───────────────────────────────────────

test("§31.9 Architectural change without ADR: rejects with spec-gate-violation", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-no-adr-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/my-arch.md"), "# Arch Spec\n");
  run(["add", "docs/specs/my-arch.md"]);
  run(["commit", "-m", "add arch spec"]);
  const specSha = run(["rev-parse", "HEAD"]).trim();

  const archContract: SpecContract = {
    kind: "behavior_change",
    specPath: "docs/specs/my-arch.md",
    specSha,
    isArchitectural: true,
    // adrPath is missing!
  };

  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "ARCH-1",
        level: "complex",
        role: "executor",
        contract: archContract,
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /требует наличия принятого ADR/);
      return true;
    },
  );
});

// ── 6. Positive execution with accepted specs / references ────────────────────

test("§31.9 Positive execution: behavior change with valid spec and ADR passes gate", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-pos-feat-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  mkdirSync(join(repoDir, "docs/adr"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/feat.md"), "# Feature Spec\n");
  writeFileSync(join(repoDir, "docs/adr/001-feat.md"), "# ADR 001\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: feature spec & adr"]);
  const specSha = run(["rev-parse", "HEAD"]).trim();

  const contract: SpecContract = {
    kind: "behavior_change",
    specPath: "docs/specs/feat.md",
    specSha,
    isArchitectural: true,
    adrPath: "docs/adr/001-feat.md",
  };

  // Must not throw
  await verifySpecBeforeCodeGate({
    taskKey: "FEAT-1",
    level: "complex",
    role: "executor",
    contract,
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "shadow",
  });
});

test("§31.9 Positive execution: bugfix referencing existing spec and section passes gate", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-pos-fix-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(
    join(repoDir, "docs/specs/graph.md"),
    "# Graph\n\n### 31.9 Единая проверка спецификации до запуска кода\n",
  );
  run(["add", "."]);
  run(["commit", "-m", "docs: graph spec"]);

  const contract: SpecContract = {
    kind: "bugfix",
    specPath: "docs/specs/graph.md",
    specSection: "§31.9",
    altersContract: false,
  };

  // Must not throw
  await verifySpecBeforeCodeGate({
    taskKey: "FIX-1",
    level: "simple",
    role: "executor",
    contract,
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "shadow",
  });
});

test("§31.9 Positive execution: mechanical work with rationale passes gate", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-pos-mech-");
  const { cmd } = initGitRepo(repoDir);

  const contract: SpecContract = {
    kind: "mechanical",
    mechanicalBasis: "Refactoring internal types without changing behavioral contracts",
  };

  // Must not throw
  await verifySpecBeforeCodeGate({
    taskKey: "MECH-1",
    level: "simple",
    role: "executor",
    contract,
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "shadow",
  });
});

// ── 7. Bugfix altering contract rejection ─────────────────────────────────────

test("§31.9 Bugfix altering contract: rejects with spec-gate-violation", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-alter-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/api.md"), "# API\n\n### Section 4\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: api spec"]);

  const contract: SpecContract = {
    kind: "bugfix",
    specPath: "docs/specs/api.md",
    specSection: "Section 4",
    altersContract: true, // Requires changing the contract!
  };

  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "FIX-ALTER-1",
        level: "simple",
        role: "executor",
        contract,
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /требует изменения договора/);
      return true;
    },
  );
});

// ── 8. Race condition test: base branch moving between prep and spawn ─────────

test("§31.9 Race condition: base branch moving between prep and spawn triggers re-verification and rejects if spec modified", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-race-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/auth.md"), "# Auth Spec v1\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: auth v1"]);
  const prepBaseSha = run(["rev-parse", "HEAD"]).trim();

  // Now base branch moves to a new commit that alters auth.md
  writeFileSync(join(repoDir, "docs/specs/auth.md"), "# Auth Spec v2 - breaking change\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: auth v2 changed by someone else"]);
  const currentBaseSha = run(["rev-parse", "HEAD"]).trim();

  const contract: SpecContract = {
    kind: "behavior_change",
    specPath: "docs/specs/auth.md",
    specSha: prepBaseSha,
    preparedBaseSha: prepBaseSha,
  };

  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "RACE-1",
        level: "complex",
        role: "executor",
        contract,
        store,
        cmd,
        repoRoot: repoDir,
        baseSha: currentBaseSha,
        preparedBaseSha: prepBaseSha,
        workGraphMode: "shadow",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /целевая базовая ветка изменилась/);
      return true;
    },
  );
});

// ── 9. Release test: exact published SHA verification (§2) ────────────────────

test("orchestrator-release §2: deletion or unapproved modification of spec during merge stops release", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-rel-");
  const { run, cmd } = initGitRepo(repoDir);

  // Commit accepted spec
  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/rel-feat.md"), "# Release Feat Spec\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: accept rel-feat spec"]);
  const acceptedSpecSha = run(["rev-parse", "HEAD"]).trim();

  // Store spec contract
  store.saveSpecContract({
    taskKey: "REL-1",
    kind: "behavior_change",
    specPath: "docs/specs/rel-feat.md",
    specSha: acceptedSpecSha,
  });

  // Scenario A: spec document was deleted during merge
  run(["rm", "docs/specs/rel-feat.md"]);
  run(["commit", "-m", "merge: accidentally deleted spec"]);
  const publishedShaDeleted = run(["rev-parse", "HEAD"]).trim();

  await assert.rejects(
    async () => {
      await verifyReleaseDocumentsGate({
        taskKey: "REL-1",
        store,
        cmd,
        repoRoot: repoDir,
        publishedSha: publishedShaDeleted,
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /была удалена при сведении ветки релиза/);
      return true;
    },
  );

  // Scenario B: spec document modified during merge without new approval
  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(
    join(repoDir, "docs/specs/rel-feat.md"),
    "# Altered Spec without new approval\n",
  );
  run(["add", "."]);
  run(["commit", "-m", "merge: altered spec content"]);
  const publishedShaModified = run(["rev-parse", "HEAD"]).trim();

  await assert.rejects(
    async () => {
      await verifyReleaseDocumentsGate({
        taskKey: "REL-1",
        store,
        cmd,
        repoRoot: repoDir,
        publishedSha: publishedShaModified,
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /была изменена при сведении ветки релиза/);
      return true;
    },
  );

  // Scenario C: clean published SHA where spec matches acceptedSpecSha
  run(["checkout", acceptedSpecSha]);
  const cleanPublishedSha = run(["rev-parse", "HEAD"]).trim();

  // Must not throw
  await verifyReleaseDocumentsGate({
    taskKey: "REL-1",
    store,
    cmd,
    repoRoot: repoDir,
    publishedSha: cleanPublishedSha,
  });
});
