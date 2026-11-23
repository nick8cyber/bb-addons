// plugins/bb-plugin-orchestrator/tests/spec-before-code-gate.test.ts
// Acceptance tests for spec-before-code gate (§31.9, orchestrator-release §2, ADR-0032)

import assert from "node:assert/strict";
import test from "node:test";

const ORIGINAL_BB_THREAD_ID = process.env.BB_THREAD_ID;
delete process.env.BB_THREAD_ID;
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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
  isSpecBeforeCodeEnforced,
  findAcceptedSpecReview,
  type SpecContract,
} from "../src/spec-gate.js";
import { runRunQueue, runApprove, runReject } from "../src/workgraph.js";
import { runDelegate, dispatchToRoute } from "../src/delegate.js";
import { OrchestratorError } from "../src/errors.js";

const POLICY_TEXT = JSON.stringify({
  version: 1,
  specBeforeCode: true,
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
  run(["add", "-A"]);
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

  // Verify gate rejects without spec contract
  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "FAVORITE-1",
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
        role: "executor",
        policy: parsePolicy(POLICY_TEXT).policy,
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  // In shadow mode, run-queue passively evaluates without throwing and records would_reject
  await runRunQueue(runQueueDeps);

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
  // Verify row was removed on spec-gate-violation (onDispatchFailure !== "fail")
  assert.equal(store.get(row.id), undefined, "Row must be removed on spec-gate-violation to prevent blocking delegations_active_task_idx");
  assert.equal(store.delegationsByTask("FALLBACK-1").length, 0);
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
    approvalId: "appr:proj_1:FOREIGN-1:sha:1",
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
    approvalId: `appr:proj_1:ARCH-1:${specSha.slice(0, 12)}:1`,
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
    approvalId: `appr:proj_1:FEAT-1:${specSha.slice(0, 12)}:1`,
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
  const specSha = run(["rev-parse", "HEAD"]).trim();

  const contract: SpecContract = {
    kind: "bugfix",
    specPath: "docs/specs/graph.md",
    specSection: "§31.9",
    specSha,
    altersContract: false,
    approvalId: "appr:proj_1:FIX-1:base:1",
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
    approvalId: "appr:proj_1:MECH-1:base:1",
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
    approvalId: "appr:proj_1:FIX-ALTER-1:base:1",
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
    approvalId: `appr:proj_1:RACE-1:${prepBaseSha.slice(0, 12)}:1`,
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
    approvalId: `appr:proj_1:REL-1:${acceptedSpecSha.slice(0, 12)}:1`,
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
        workGraphMode: "shadow",
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
        workGraphMode: "shadow",
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
    workGraphMode: "shadow",
  });
});

// ── 10. Blocker 2: simple route without accepted classification gives 0 spawns ─

test("§31.9 Blocker 2: simple route with arbitrary text or single SHA without classification rejects and produces 0 spawns", async () => {
  const spawnedThreads: any[] = [];
  const fake = fakeCli();
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-spec-simple-nochk-"),
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

  const { store } = await createPlugin(host.bb, { bbCli: fake.cli });

  // 1. Task with arbitrary acceptance text on simple route
  store.insertTask({
    taskKey: "SIMPLE-ARB-1",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
    payload: JSON.stringify({ acceptance_text: "Arbitrary text without any kind or spec specification" }),
  });

  const repoDir = makeTempDir("orch-simple-arb-");
  const { cmd } = initGitRepo(repoDir);

  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "SIMPLE-ARB-1",
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
        role: "executor",
        policy: parsePolicy(POLICY_TEXT).policy,
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  await runRunQueue({
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "shadow",
    policy: parsePolicy(POLICY_TEXT).policy,
  });
  const t1 = store.getTask("SIMPLE-ARB-1")!;
  const p1 = JSON.parse(t1.payload ?? "{}");
  assert.equal(p1.shadow_eval?.would_reject, "spec-gate-violation");
  assert.equal(spawnedThreads.length, 0, "0 threads spawned for arbitrary acceptance text");

  // 2. Task with single acceptance_sha on simple route without classification
  store.insertTask({
    taskKey: "SIMPLE-SHA-1",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
    payload: JSON.stringify({}),
  });
  store.updateTask("SIMPLE-SHA-1", {
    acceptance_sha: "1234567890123456789012345678901234567890",
  });

  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "SIMPLE-SHA-1",
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
        role: "executor",
        policy: parsePolicy(POLICY_TEXT).policy,
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  await runRunQueue({
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "shadow",
    policy: parsePolicy(POLICY_TEXT).policy,
  });
  const t2 = store.getTask("SIMPLE-SHA-1")!;
  const p2 = JSON.parse(t2.payload ?? "{}");
  assert.equal(p2.shadow_eval?.would_reject, "spec-gate-violation");
  assert.equal(spawnedThreads.length, 0, "0 threads spawned for single SHA without classification");
});

// ── 11. Blocker 1: connected positive flow ─────────────────────────────────────

test("§31.9 Blocker 1: connected positive flow: approval stores contract -> launch verifies exact saved contract -> release verifies exact same contract", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-pos-flow-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/pos-flow.md"), "# Flow Spec\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: initial spec"]);
  const acceptedSha = run(["rev-parse", "HEAD"]).trim();

  // Enqueue task at owner_gate waiting for approval
  store.insertTask({
    taskKey: "FLOW-1",
    projectId: "proj_flow",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "manual",
    payload: JSON.stringify({
      gate_stage: "pre_code",
      spec_path: "docs/specs/pos-flow.md",
      spec_sha: acceptedSha,
    }),
  });
  store.updateTask("FLOW-1", {
    node: "owner_gate",
    status: "waiting_approval",
  });

  // Verify task_spec_contracts is initially empty
  assert.equal(store.getSpecContract("FLOW-1"), null);

  // Step 1: Owner calls runApprove
  const fakeCtx: any = { isOwner: true, projectId: "proj_flow" };
  const approveRes = await runApprove("FLOW-1", "approved by owner", {
    store,
    ctx: fakeCtx,
    workGraphMode: "shadow",
  });
  assert.equal(approveRes.ok, true);

  // Contract must now be saved in task_spec_contracts with approvalId
  const savedContract = store.getSpecContract("FLOW-1");
  assert.notEqual(savedContract, null);
  assert.equal(savedContract!.kind, "behavior_change");
  assert.equal(savedContract!.spec_path, "docs/specs/pos-flow.md");
  assert.equal(savedContract!.spec_sha, acceptedSha);
  assert.notEqual(savedContract!.approval_id, null);
  assert.match(savedContract!.approval_id!, /^appr:proj_flow:FLOW-1:/);

  // Step 2: Code launch verifies exact saved contract
  // Must NOT throw
  await verifySpecBeforeCodeGate({
    taskKey: "FLOW-1",
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "shadow",
    role: "executor",
  });

  // Step 3: Release verifies exact same contract on published SHA
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src/code.ts"), "export const x = 1;\n");
  run(["add", "."]);
  run(["commit", "-m", "feat: implement code"]);
  const publishedSha = run(["rev-parse", "HEAD"]).trim();

  // Must NOT throw
  await verifyReleaseDocumentsGate({
    taskKey: "FLOW-1",
    store,
    cmd,
    repoRoot: repoDir,
    publishedSha,
    workGraphMode: "shadow",
  });
});

// ── 12. Blocker 1: connected negative flow ─────────────────────────────────────

test("§31.9 Blocker 1: connected negative flow: rejection/revocation revokes approval and blocks launch and release", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-neg-flow-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/neg-flow.md"), "# Neg Spec\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: neg spec"]);
  const acceptedSha = run(["rev-parse", "HEAD"]).trim();

  store.insertTask({
    taskKey: "NEG-1",
    projectId: "proj_neg",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "manual",
    payload: JSON.stringify({
      gate_stage: "pre_code",
      spec_path: "docs/specs/neg-flow.md",
      spec_sha: acceptedSha,
    }),
  });
  store.updateTask("NEG-1", {
    node: "owner_gate",
    status: "waiting_approval",
  });

  // Approve first
  const fakeCtx: any = { isOwner: true, projectId: "proj_neg" };
  await runApprove("NEG-1", "ok", { store, ctx: fakeCtx, workGraphMode: "shadow" });
  assert.notEqual(store.getSpecContract("NEG-1")?.approval_id, null);

  // Now approval is revoked
  store.revokeSpecContractApproval("NEG-1");

  // Approval ID in task_spec_contracts must be revoked (NULL)
  const contractAfterReject = store.getSpecContract("NEG-1");
  assert.equal(contractAfterReject?.approval_id, null);

  // Launch must reject
  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "NEG-1",
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
        role: "executor",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /approvalId отсутствует/);
      return true;
    },
  );

  // Release must also reject
  await assert.rejects(
    async () => {
      await verifyReleaseDocumentsGate({
        taskKey: "NEG-1",
        store,
        cmd,
        repoRoot: repoDir,
        publishedSha: acceptedSha,
        workGraphMode: "shadow",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /approvalId отсутствует/);
      return true;
    },
  );

  // Release without any contract at all must also reject when enforced
  await assert.rejects(
    async () => {
      await verifyReleaseDocumentsGate({
        taskKey: "NO-CONTRACT-1",
        store,
        cmd,
        repoRoot: repoDir,
        publishedSha: acceptedSha,
        workGraphMode: "shadow",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
});

// ── 13. Blocker 3: connected tests (two repos, inaccessible git, drift) ────────

test("§31.9 Blocker 3: two repositories: task repository is used for git checks, not coordinator cwd", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  // Repo A = coordinator cwd (does NOT have spec)
  const repoA = makeTempDir("orch-spec-repo-a-");
  const { run: runA, cmd: cmdA } = initGitRepo(repoA);

  // Repo B = actual task repository (HAS accepted spec)
  const repoB = makeTempDir("orch-spec-repo-b-");
  const { run: runB, cmd: cmdB } = initGitRepo(repoB);

  mkdirSync(join(repoB, "docs/specs"), { recursive: true });
  writeFileSync(join(repoB, "docs/specs/repo-b.md"), "# Repo B Spec\n");
  runB(["add", "."]);
  runB(["commit", "-m", "docs: repo b spec"]);
  const specShaB = runB(["rev-parse", "HEAD"]).trim();

  store.saveSpecContract({
    taskKey: "MULTI-REPO-1",
    projectId: "proj_b",
    kind: "behavior_change",
    specPath: "docs/specs/repo-b.md",
    specSha: specShaB,
    approvalId: `appr:proj_b:MULTI-REPO-1:${specShaB.slice(0, 12)}:1`,
  });

  // Verifying with Repo B as confirmed repoRoot passes
  await verifySpecBeforeCodeGate({
    taskKey: "MULTI-REPO-1",
    store,
    cmd: cmdB,
    repoRoot: repoB,
    workGraphMode: "shadow",
    role: "executor",
  });

  // If Repo A were mistakenly used, it must fail because spec is not in Repo A
  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "MULTI-REPO-1",
        store,
        cmd: cmdA,
        repoRoot: repoA,
        workGraphMode: "shadow",
        role: "executor",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
});

test("§31.9 Blocker 3: missing or inaccessible git base explicitly refuses with spec-gate-violation", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  store.saveSpecContract({
    taskKey: "NOGIT-1",
    projectId: "proj_1",
    kind: "mechanical",
    mechanicalBasis: "Refactoring internal utilities",
    approvalId: "appr:proj_1:NOGIT-1:base:1",
  });

  // 1. Missing repoRoot entirely
  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "NOGIT-1",
        store,
        workGraphMode: "shadow",
        role: "executor",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /репозиторий задачи NOGIT-1 не определён или недоступен/);
      return true;
    },
  );

  // 2. Non-existent repo directory with failing git command
  const fakeCmd: CmdRunner = {
    run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }),
  };

  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "NOGIT-1",
        store,
        cmd: fakeCmd,
        repoRoot: "/non/existent/path",
        workGraphMode: "shadow",
        role: "executor",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /не удалось разрешить базовый коммит/);
      return true;
    },
  );
});

test("§31.9 Blocker 3: spec modified in base after acceptance is detected via git diff and rejects with spec-gate-violation", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-drift-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/drift.md"), "# Accepted Spec v1\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: accept v1"]);
  const acceptedSha = run(["rev-parse", "HEAD"]).trim();

  store.saveSpecContract({
    taskKey: "DRIFT-1",
    projectId: "proj_1",
    kind: "behavior_change",
    specPath: "docs/specs/drift.md",
    specSha: acceptedSha,
    approvalId: `appr:proj_1:DRIFT-1:${acceptedSha.slice(0, 12)}:1`,
  });

  // Now someone changes drift.md in a new base commit before code starts
  writeFileSync(join(repoDir, "docs/specs/drift.md"), "# Drifted Spec without re-approval\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: modify spec in base"]);
  const driftedBaseSha = run(["rev-parse", "HEAD"]).trim();

  // verifySpecBeforeCodeGate must detect the diff and reject
  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "DRIFT-1",
        store,
        cmd,
        repoRoot: repoDir,
        baseSha: driftedBaseSha,
        workGraphMode: "shadow",
        role: "executor",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /была изменена по сравнению с принятой версией/);
      return true;
    },
  );
});

// ── 16. Audit Contract Scenarios: (1) Auto flow, (2) Project overrides, (3) No-code/research, (4) Upgrade compatibility ──

test("§31.9 Audit Scenario (1): auto confirmation mode persists contract and passes launch and release", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-auto-flow-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/auto-spec.md"), "# Auto Spec\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: initial auto spec"]);
  const acceptedSha = run(["rev-parse", "HEAD"]).trim();

  // Task in auto mode: spec_review OK transitions to code and saves contract
  store.insertTask({
    taskKey: "AUTO-1",
    projectId: "proj_auto",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
    payload: JSON.stringify({
      spec_path: "docs/specs/auto-spec.md",
      spec_sha: acceptedSha,
    }),
  });
  store.updateTask("AUTO-1", {
    node: "owner_gate",
    status: "waiting_approval",
  });

  // Auto approve simulation via runApprove
  const fakeCtx: any = { isOwner: true, projectId: "proj_auto" };
  const approveRes = await runApprove("AUTO-1", "auto approved", {
    store,
    ctx: fakeCtx,
    workGraphMode: "shadow",
  });
  assert.equal(approveRes.ok, true);

  const saved = store.getSpecContract("AUTO-1");
  assert.notEqual(saved, null);
  assert.equal(saved?.spec_path, "docs/specs/auto-spec.md");
  assert.notEqual(saved?.approval_id, null);

  // Launch verifies saved contract
  await verifySpecBeforeCodeGate({
    taskKey: "AUTO-1",
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "shadow",
    role: "executor",
  });

  // Release verifies same contract
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src/index.ts"), "export const ok = true;\n");
  run(["add", "."]);
  run(["commit", "-m", "feat: code done"]);
  const pubSha = run(["rev-parse", "HEAD"]).trim();

  await verifyReleaseDocumentsGate({
    taskKey: "AUTO-1",
    store,
    cmd,
    repoRoot: repoDir,
    publishedSha: pubSha,
    workGraphMode: "shadow",
  });
});

test("§31.9 Audit Scenario (2): project overrides and projects outside requirement continue normal operations", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-override-");
  const { cmd } = initGitRepo(repoDir);

  // Project with specBeforeCode: false is outside requirement -> normal code launch proceeds without contract
  const unconstrainedProject: any = { id: "proj_legacy", specBeforeCode: false };
  await verifySpecBeforeCodeGate({
    taskKey: "UNCONSTRAINED-1",
    store,
    cmd,
    repoRoot: repoDir,
    project: unconstrainedProject,
    role: "executor",
    specBeforeCode: false,
  });

  // Project with specBeforeCode: true enforces gate -> rejects before thread spawn
  const enforcedProject: any = { id: "proj_enforced", specBeforeCode: true };
  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "ENFORCED-1",
        store,
        cmd,
        repoRoot: repoDir,
        project: enforcedProject,
        role: "executor",
        specBeforeCode: true,
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
});

test("§31.9 Audit Scenario (3): non-code operations (architect, research, noCode) bypass gate and run normally", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-nocode-");
  const { cmd } = initGitRepo(repoDir);

  // 1. role: architect (design node) does not require spec contract
  await verifySpecBeforeCodeGate({
    taskKey: "ARCH-TASK-1",
    store,
    cmd,
    repoRoot: repoDir,
    role: "architect",
    workGraphMode: "shadow",
  });

  // 2. role: researcher does not require spec contract
  await verifySpecBeforeCodeGate({
    taskKey: "RES-TASK-1",
    store,
    cmd,
    repoRoot: repoDir,
    role: "researcher",
    workGraphMode: "shadow",
  });

  // 3. noCode: true does not require spec contract
  await verifySpecBeforeCodeGate({
    taskKey: "NOCODE-TASK-1",
    store,
    cmd,
    repoRoot: repoDir,
    role: "executor",
    noCode: true,
    workGraphMode: "shadow",
  });
});

test("§31.9 Audit Scenario (4): upgrade compatibility - legacy tasks without contract in DB reject before spawning thread", async () => {
  const spawnedThreads: any[] = [];
  const fake = fakeCli();
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-spec-upgrade-compat-"),
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

  // Upgraded system receives delegation for legacy task without spec contract
  const res = await host.harness.runCli(
    ["delegate", "LEGACY-1", "--level", "simple", "--json"],
    { threadId: "thr_coord" },
  );

  assert.notEqual(res.exitCode, 0);
  assert.match(res.stderr + res.stdout, /spec-gate-violation/);
  // Crucial requirement: mandatory refusal happens strictly BEFORE creating a thread
  assert.equal(spawnedThreads.length, 0, "0 threads spawned for unapproved legacy task");
});

test("§31.9 Architect Incident (PLUG-371): live no-row path without task_queue or contract row resolves proof from delegations and reviews", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-plug371-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src/index.ts"), "export const ok = 1;\n");
  run(["add", "."]);
  run(["commit", "-m", "feat: legacy code"]);
  const codeSha = run(["rev-parse", "HEAD"]).trim();

  // Exactly matching live PLUG-371 DB state:
  // count(task_queue) = 0 and count(task_spec_contracts) = 0
  assert.equal(store.listAllTasks().length, 0);
  assert.equal(store.getSpecContract("PLUG-371"), null);

  // Delegation #1745: executor round produced codeSha
  const exec = store.insert({
    taskKey: "PLUG-371",
    projectId: "proj_z6bxvt43zb",
    coordinatorThreadId: "thr_ctphpsrvcg",
    level: "simple",
    route: "oc-nemotron-lightning",
    preset: "oc-nemotron",
    provider: "acp-opencode",
    continueFrom: codeSha,
  });
  store.setStatus(exec.id, "done");
  store.setRoundResult(exec.id, {
    branch: "main",
    sha: codeSha,
    commits: 1,
    dirty: false,
  });

  // Delegation #1744: review round for codeSha with OK verdict
  const rev = store.insert({
    taskKey: "PLUG-371",
    projectId: "proj_z6bxvt43zb",
    coordinatorThreadId: "thr_ctphpsrvcg",
    level: "review",
    route: "gemini",
    preset: "gemini-38-wt",
    provider: "agy",
    continueFrom: codeSha,
  });
  store.setStatus(rev.id, "running");
  store.setStatusIf(rev.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  });

  // 1. Release documents gate on reviewed SHA succeeds without task_queue row or contract row
  await verifyReleaseDocumentsGate({
    taskKey: "PLUG-371",
    store,
    cmd,
    repoRoot: repoDir,
    publishedSha: codeSha,
    workGraphMode: "shadow",
  });

  // 2. Release documents gate on a DIFFERENT SHA rejects with spec-gate-violation
  const diffSha = "1111111111111111111111111111111111111111";
  await assert.rejects(
    verifyReleaseDocumentsGate({
      taskKey: "PLUG-371",
      store,
      cmd,
      repoRoot: repoDir,
      publishedSha: diffSha,
      workGraphMode: "shadow",
    }),
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  // 3. Release documents gate on a NEW task without review evidence rejects with spec-gate-violation
  await assert.rejects(
    verifyReleaseDocumentsGate({
      taskKey: "PLUG-NEW",
      store,
      cmd,
      repoRoot: repoDir,
      publishedSha: codeSha,
      workGraphMode: "shadow",
    }),
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  // 4. Code launch gate on a task without saved spec contract rejects with spec-gate-violation
  // (§31.9 Blocker 1: review evidence only valid for release verification, never for code launch)
  await assert.rejects(
    verifySpecBeforeCodeGate({
      taskKey: "PLUG-371",
      store,
      cmd,
      repoRoot: repoDir,
      role: "executor",
      workGraphMode: "shadow",
      preparedBaseSha: codeSha,
    }),
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
});

test("§31.9 Project resolution: specBeforeCode undefined in layer falls back to workGraphMode", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-unset-config-");
  const { cmd } = initGitRepo(repoDir);

  // When specBeforeCode is not specified in project, isSpecBeforeCodeEnforced honors workGraphMode
  const projectWithoutSpecConfig: any = { id: "proj_unset" };

  assert.equal(
    isSpecBeforeCodeEnforced({
      project: projectWithoutSpecConfig,
      workGraphMode: "shadow",
      specBeforeCode: undefined,
    }),
    true,
  );

  assert.equal(
    isSpecBeforeCodeEnforced({
      project: projectWithoutSpecConfig,
      workGraphMode: "off",
      specBeforeCode: undefined,
    }),
    false,
  );
});

test("§31.9 Opus Audit Round 2 Blockers 1 & 2: simple route in auto without basis stays queued; code gate rejects task without spec despite review evidence", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const repoDir = makeTempDir("audit-r2-b12-");
  const { cmd } = initGitRepo(repoDir);

  // Blocker 2: simple route in auto mode without explicit acceptance basis
  store.insertTask({
    taskKey: "SIMPLE-AUTO-1",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });
  const dispatched: string[] = [];
  await runRunQueue({
    store,
    cmd,
    repoRoot: repoDir,
    mergeBaseBranch: "main",
    workGraphMode: "strict",
    policy: null,
    dispatchNode: async (_t: any, n: any) => { dispatched.push(n); return { ok: true }; },
  } as any);

  const t1 = store.getTask("SIMPLE-AUTO-1")!;
  assert.equal(t1.node, "start", "task must stay at start node");
  assert.equal(t1.status, "queued", "task must stay queued");
  assert.equal(dispatched.length, 0, "no nodes dispatched");
  assert.equal(store.getSpecContract("SIMPLE-AUTO-1"), null, "no contract fabricated");

  // Blocker 1: task with review evidence but no spec contract is rejected by verifySpecBeforeCodeGate
  const rev = store.insert({
    taskKey: "BEHAV-REV-1",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review-route",
    preset: "auditor",
    provider: "x",
    continueFrom: "0123456789abcdef0123456789abcdef01234567",
  });
  store.setStatus(rev.id, "done");
  await assert.rejects(
    verifySpecBeforeCodeGate({
      taskKey: "BEHAV-REV-1",
      role: "executor",
      level: "complex",
      store,
      cmd,
      repoRoot: repoDir,
      workGraphMode: "shadow",
    }),
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
});

test("§31.9 Opus Audit Round 2 Blocker 3: design_check CHANGES targeting code preserves spec contract approval", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const repoDir = makeTempDir("audit-r2-b3-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/feature-x.md"), "# Feature X\n");
  run(["add", "."]);
  run(["commit", "-m", "spec"]);
  const specSha = run(["rev-parse", "HEAD"]).trim();

  store.insertTask({
    taskKey: "DES-CHECK-1",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
    payload: JSON.stringify({
      design_check_verdict: "CHANGES",
      design_check_target: "code",
      design_check_blockers: 1,
    }),
  });
  store.updateTask("DES-CHECK-1", { node: "design_check", status: "running", branch: "main" });
  const approvalId = `appr:proj_1:DES-CHECK-1:${specSha}:1`;
  store.saveSpecContract({
    taskKey: "DES-CHECK-1",
    projectId: "proj_1",
    kind: "behavior_change",
    specPath: "docs/specs/feature-x.md",
    specSha,
    approvalId,
  });

  const dispatched: string[] = [];
  await runRunQueue({
    store,
    cmd,
    repoRoot: repoDir,
    mergeBaseBranch: "main",
    workGraphMode: "strict",
    policy: null,
    dispatchNode: async (_t: any, n: any) => { dispatched.push(n); return { ok: true }; },
  } as any);

  const t = store.getTask("DES-CHECK-1")!;
  assert.equal(t.node, "code", "must transition to code");
  assert.equal(t.status, "running", "must be running");
  assert.deepEqual(dispatched, ["code"], "code node must be dispatched");
  assert.equal(store.getSpecContract("DES-CHECK-1")?.approval_id, approvalId, "approval_id must be preserved");
});

test("§31.9 Opus Audit Round 2 Blocker 4: project specBeforeCode config honored via resolveProject in delegate and run-queue", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const repoDir = makeTempDir("audit-r2-b4-");
  const { cmd } = initGitRepo(repoDir);

  const mockResolvedProject = (specBeforeCode?: boolean): any => ({
    excluded: false,
    target: { action: "push", branch: "main" },
    sync: "merge",
    checks: [],
    specBeforeCode,
  });

  // Project with specBeforeCode: false allows code execution in shadow mode without spec
  await verifySpecBeforeCodeGate({
    taskKey: "PROJ-OFF-1",
    store,
    cmd,
    repoRoot: repoDir,
    role: "executor",
    workGraphMode: "shadow",
    project: mockResolvedProject(false),
  });

  // Project with specBeforeCode: true enforces spec gate even when workGraphMode is off
  await assert.rejects(
    verifySpecBeforeCodeGate({
      taskKey: "PROJ-ON-1",
      store,
      cmd,
      repoRoot: repoDir,
      role: "executor",
      workGraphMode: "off",
      project: mockResolvedProject(true),
    }),
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
});

test("§31.9 Opus Audit Round 2 Blocker 5: two different 40-char SHAs sharing 8-char prefix are strictly rejected", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const repoDir = makeTempDir("audit-r2-b5-");
  const { cmd } = initGitRepo(repoDir);

  const SHA_A = "1111222233334444555566667777888899990000";
  const SHA_B = "1111222200000000000000000000000000000000"; // shares first 8 chars

  // 1. Store getLatestAcceptedReview
  const rev = store.insert({
    taskKey: "REV-PREFIX-1",
    projectId: "p1",
    coordinatorThreadId: "thr_c",
    level: "review",
    route: "r",
    preset: "r",
    provider: "p",
    continueFrom: SHA_B,
  });
  store.setStatus(rev.id, "running");
  store.setStatusIf(rev.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  });
  assert.equal(
    store.getLatestAcceptedReview("REV-PREFIX-1", SHA_A),
    null,
    "store.getLatestAcceptedReview must NOT match different SHA sharing prefix",
  );

  // 2. verifySpecBeforeCodeGate approval verification
  store.saveSpecContract({
    taskKey: "GATE-PREFIX-1",
    projectId: "p1",
    kind: "behavior_change",
    specPath: "docs/specs/test.md",
    specSha: SHA_A,
    approvalId: `appr:transition:p1:GATE-PREFIX-1:${SHA_B}:1`,
  });
  await assert.rejects(
    verifySpecBeforeCodeGate({
      taskKey: "GATE-PREFIX-1",
      store,
      cmd,
      repoRoot: repoDir,
      role: "executor",
      workGraphMode: "shadow",
    }),
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  // 3. verifyReleaseDocumentsGate
  await assert.rejects(
    verifyReleaseDocumentsGate({
      taskKey: "GATE-PREFIX-1",
      store,
      cmd,
      repoRoot: repoDir,
      publishedSha: SHA_A,
      workGraphMode: "shadow",
    }),
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
});

test("§31.9 Opus Audit Round 3 Blocker 2: simple task in review/checks node without contract is rejected by code gate", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const repoDir = makeTempDir("audit-r3-b2-");
  const { cmd } = initGitRepo(repoDir);

  // Task in review node with no contract in task_spec_contracts and no acceptance text
  store.insertTask({
    taskKey: "LEG-REV-1",
    projectId: "p1",
    coordinatorThreadId: "thr_c",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });
  store.updateTask("LEG-REV-1", { node: "review", status: "running" });

  // Code gate must NOT resolve contract from task_queue row when !forRelease
  const contractForCode = resolveTaskSpecContract("LEG-REV-1", store, null, { forRelease: false });
  assert.equal(contractForCode, null, "resolveTaskSpecContract for code must NOT synthesize contract from queue row");

  // Code gate must reject execution
  await assert.rejects(
    verifySpecBeforeCodeGate({
      taskKey: "LEG-REV-1",
      role: "executor",
      level: "simple",
      store,
      cmd,
      repoRoot: repoDir,
      workGraphMode: "shadow",
    }),
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  // But for release verification (forRelease: true), transition contract can be resolved
  const contractForRel = resolveTaskSpecContract("LEG-REV-1", store, null, { forRelease: true });
  assert.ok(contractForRel, "resolveTaskSpecContract for release resolves transition contract");
  assert.equal(contractForRel?.kind, "mechanical");
});

test("§31.9 Opus Audit Round 3 Blocker 3: approval revocation resets spec_sha and re-approval binds to new spec version", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const repoDir = makeTempDir("audit-r3-b3-");
  const { cmd } = initGitRepo(repoDir);

  const specPath = "docs/specs/feature-x.md";
  const specFullPath = join(repoDir, specPath);
  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });

  // 1. Spec v1 commit
  writeFileSync(specFullPath, "# Spec v1\nInitial specification content\n");
  execFileSync("git", ["add", specPath], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "spec v1"], { cwd: repoDir });
  const shaV1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

  // Task setup in owner_gate with v1
  store.insertTask({
    taskKey: "SPEC-CYCLE-1",
    projectId: "p1",
    coordinatorThreadId: "thr_c",
    route: "feature",
    level: "complex",
    confirmationMode: "manual",
    payload: JSON.stringify({ spec_path: specPath, spec_sha: shaV1, gate_stage: "pre_code" }),
  });
  store.updateTask("SPEC-CYCLE-1", { node: "owner_gate", status: "waiting_approval" });

  // Approve v1 via runApprove
  await runApprove("SPEC-CYCLE-1", "Approved v1", {
    store,
    ctx: { cwd: repoDir } as any,
    workGraphMode: "strict",
    now: () => 1000,
  });

  // Verify contract is approved for shaV1
  let contract = store.getSpecContract("SPEC-CYCLE-1");
  assert.ok(contract?.approval_id);
  assert.equal(contract?.spec_sha, shaV1);

  // verifySpecBeforeCodeGate succeeds for shaV1
  await verifySpecBeforeCodeGate({
    taskKey: "SPEC-CYCLE-1",
    role: "executor",
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "strict",
  });

  // 2. Task returned to spec (e.g. rejection or design remark), revoking approval
  store.revokeSpecContractApproval("SPEC-CYCLE-1", 2000);
  contract = store.getSpecContract("SPEC-CYCLE-1");
  assert.equal(contract?.approval_id, null, "approval_id must be reset to null");
  assert.equal(contract?.spec_sha, null, "spec_sha must be reset to null");

  // 3. Edit spec to v2
  writeFileSync(specFullPath, "# Spec v2\nUpdated specification content\n");
  execFileSync("git", ["add", specPath], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "spec v2"], { cwd: repoDir });
  const shaV2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  assert.notEqual(shaV1, shaV2);

  // Update task payload with fresh spec_sha and place back in owner_gate
  store.updateTask("SPEC-CYCLE-1", {
    node: "owner_gate",
    status: "waiting_approval",
    payload: JSON.stringify({ spec_path: specPath, spec_sha: shaV2, gate_stage: "pre_code" }),
  });

  // 4. Re-approve v2
  await runApprove("SPEC-CYCLE-1", "Approved v2", {
    store,
    ctx: { cwd: repoDir } as any,
    workGraphMode: "strict",
    now: () => 3000,
  });

  // Verify contract was re-approved with shaV2 and full SHA in approvalId
  contract = store.getSpecContract("SPEC-CYCLE-1");
  assert.equal(contract?.spec_sha, shaV2, "contract must now have fresh shaV2");
  assert.ok(contract?.approval_id?.includes(shaV2), "approval_id must contain full shaV2");

  // 5. verifySpecBeforeCodeGate succeeds with shaV2!
  await verifySpecBeforeCodeGate({
    taskKey: "SPEC-CYCLE-1",
    role: "executor",
    store,
    cmd,
    repoRoot: repoDir,
    workGraphMode: "strict",
  });
});

test("§31.9 Opus Audit Round 4 Blocker 3: real path re-approval when column spec_sha updated and payload retained", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const repoDir = makeTempDir("audit-r4-b3-");
  const { cmd } = initGitRepo(repoDir);

  const specPath = "docs/specs/feature-r4.md";
  const specFullPath = join(repoDir, specPath);
  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });

  writeFileSync(specFullPath, "# Spec v1\nInitial specification content\n");
  execFileSync("git", ["add", specPath], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "spec v1"], { cwd: repoDir });
  const shaA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

  store.insertTask({
    taskKey: "SPEC-R4-1",
    projectId: "p1",
    coordinatorThreadId: "thr_c",
    route: "feature",
    level: "complex",
    confirmationMode: "manual",
    payload: JSON.stringify({ spec_path: specPath, gate_stage: "pre_code" }),
  });
  store.updateTask("SPEC-R4-1", { node: "owner_gate", status: "waiting_approval", spec_sha: shaA } as any);

  await runApprove("SPEC-R4-1", "ok", { store, ctx: { cwd: repoDir } as any, workGraphMode: "strict", now: () => 1000 });
  await verifySpecBeforeCodeGate({ taskKey: "SPEC-R4-1", role: "executor", store, cmd, repoRoot: repoDir, workGraphMode: "strict" });

  // return to spec (as runReject code->spec does)
  store.revokeSpecContractApproval("SPEC-R4-1", 2000);

  // spec node round 2: writes column spec_sha=B, keeps payload (or spreads old payload)
  writeFileSync(specFullPath, "# Spec v2\nUpdated specification content\n");
  execFileSync("git", ["add", specPath], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "spec v2"], { cwd: repoDir });
  const shaB = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

  const pl = JSON.parse(store.getTask("SPEC-R4-1")!.payload!);
  store.updateTask("SPEC-R4-1", {
    node: "owner_gate",
    status: "waiting_approval",
    spec_sha: shaB,
    payload: JSON.stringify({ ...pl, spec_done: false }),
  } as any);

  await runApprove("SPEC-R4-1", "ok2", { store, ctx: { cwd: repoDir } as any, workGraphMode: "strict", now: () => 3000 });
  const contract = store.getSpecContract("SPEC-R4-1");
  assert.equal(contract?.spec_sha, shaB, "re-approved contract must have shaB");

  await verifySpecBeforeCodeGate({ taskKey: "SPEC-R4-1", role: "executor", store, cmd, repoRoot: repoDir, workGraphMode: "strict" });
});

test("§31.9 Opus Audit Non-blocker 6: runDelegate and runRunQueue pass resolveProject end-to-end", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const repoDir = makeTempDir("audit-nb6-");
  const { cmd } = initGitRepo(repoDir);

  let resolveProjectCalled = 0;
  const resolveProject = (pid: string): any => {
    resolveProjectCalled++;
    if (pid === "proj-off") {
      return { excluded: false, specBeforeCode: false };
    }
    return { excluded: false, specBeforeCode: true };
  };

  // 1. runRunQueue passes resolveProject to verifySpecBeforeCodeGate
  store.insertTask({
    taskKey: "TASK-PROJ-OFF",
    projectId: "proj-off",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });

  const qRes = await runRunQueue({
    store,
    cmd,
    repoRoot: repoDir,
    mergeBaseBranch: "main",
    workGraphMode: "shadow",
    autoAdvance: true,
    policy: null,
    resolveProject,
  } as any);

  assert.ok(resolveProjectCalled > 0, "runRunQueue must call resolveProject");
  const taskAfter = store.getTask("TASK-PROJ-OFF");
  assert.equal(taskAfter?.node, "code", "Task with specBeforeCode: false bypassed gate and advanced to code");

  // 2. runDelegate passes resolveProject to verifySpecBeforeCodeGate
  const resolveProjectDelegateCalls: string[] = [];
  const fakePolicy = parsePolicy(POLICY_TEXT);
  const delRes = await runDelegate(
    {
      taskKey: "TASK-PROJ-OFF",
      level: "simple",
      caller: {
        threadId: "thr_coord",
        parentThreadId: null,
        title: "coordinate work",
        originPluginId: null,
        projectId: "proj-off",
      },
    },
    {
      store,
      loadPolicy: async () => fakePolicy,
      probes: {
        roleByThreadId: () => undefined,
        delegationByThreadId: (id: number) => store.byThreadId(String(id)),
        hasFreshDispatching: () => false,
      },
      threads: {
        spawn: async () => ({ id: "thr_exec_off" }),
        list: async () => [],
        getPluginMetadata: async () => null,
        update: async () => ({}),
        stop: async () => ({}),
        updatePluginMetadata: async () => ({}),
      },
      workGraphMode: () => "shadow",
      resolveProject: (pid: string) => {
        resolveProjectDelegateCalls.push(pid);
        return { excluded: false, specBeforeCode: false };
      },
      repoRoot: repoDir,
      cmd,
      bbCli: {
        run: async (args: string[]) => {
          const key = args.join(" ");
          if (key.startsWith("tasks show")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                task: { id: "t1", key: args[2] ?? "TASK-PROJ-OFF", title: "Task", description: "desc", status: "todo" },
                project: { linkedBbProjectId: "proj-off" },
              }),
              stderr: "",
            };
          }
          if (key.startsWith("tasks preset show")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                preset: {
                  providerId: "acp-opencode",
                  modelId: "m1",
                  reasoningLevel: "medium",
                  serviceTier: null,
                  permissionMode: "full",
                  environmentKind: "project-default",
                  instructions: "",
                },
              }),
              stderr: "",
            };
          }
          if (key.startsWith("thread show")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ thread: { parentThreadId: "thr_coord", visibility: "hidden" } }),
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
      } as any,
      unavailableRoutes: new Set(),
      policy: fakePolicy,
    } as any,
  );

  assert.ok(resolveProjectDelegateCalls.includes("proj-off"), "runDelegate must call resolveProject with task's projectId");
  assert.ok(delRes.delegationId, "delegation succeeded because specBeforeCode: false was resolved");
});

// ── 16. Opus Audit Round 5 Blockers (1, 2, 3) ────────────────────────────────

function makeAuditR5Repo() {
  const d = makeTempDir("r5-audit-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
  execFileSync("git", ["config", "user.email", "a@b"], { cwd: d });
  execFileSync("git", ["config", "user.name", "a"], { cwd: d });
  mkdirSync(join(d, "docs/specs/acceptance"), { recursive: true });
  writeFileSync(join(d, "docs/specs/acceptance/LEG-F-1.md"), "acc\n");
  execFileSync("git", ["add", "."], { cwd: d });
  execFileSync("git", ["commit", "-qm", "acc"], { cwd: d });
  const A = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  writeFileSync(join(d, "code.ts"), "x\n");
  execFileSync("git", ["add", "."], { cwd: d });
  execFileSync("git", ["commit", "-qm", "code"], { cwd: d });
  const P = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  return { d, A, P };
}

for (const mode of ["shadow", "off"] as const) {
  test(`§31.9 Opus Audit Round 5 Blocker 3: in-flight legacy task, acceptance_sha!=published, mode=${mode}`, async () => {
    const db = new Database(":memory:");
    for (const m of MIGRATIONS) db.exec(m);
    const store = new DelegationStore(db);
    const { d, A, P } = makeAuditR5Repo();
    const { cmd } = initGitRepo(d);
    store.insertTask({
      taskKey: "LEG-F-1",
      projectId: "p1",
      coordinatorThreadId: "thr_c",
      route: "feature",
      level: "complex",
      confirmationMode: "manual",
    } as any);
    store.updateTask("LEG-F-1", { node: "release", status: "running", acceptance_sha: A } as any);
    const c = resolveTaskSpecContract("LEG-F-1", store, undefined, { forRelease: true, targetSha: P });
    assert.ok(c);
    let err: any = null;
    try {
      await verifyReleaseDocumentsGate({ taskKey: "LEG-F-1", store, cmd, repoRoot: d, publishedSha: P, workGraphMode: mode });
    } catch (e) {
      err = e;
    }
    assert.equal(err, null, `verifyReleaseDocumentsGate must pass in mode ${mode}`);
  });
}

test("§31.9 Opus Audit Round 5 Blocker 1: real feature path: free-form acceptance, spec node delivered, owner approves, then code gate", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const { d, A } = makeAuditR5Repo();
  const { cmd } = initGitRepo(d);
  store.insertTask({
    taskKey: "FEAT-1",
    projectId: "p1",
    coordinatorThreadId: "thr_c",
    route: "feature",
    level: "complex",
    confirmationMode: "manual",
    payload: JSON.stringify({ acceptance_text: "Избранные модели сохраняются между сессиями\nКритерий 1 — кнопка звезды" }),
  } as any);
  store.updateTask("FEAT-1", {
    node: "owner_gate",
    status: "waiting_approval",
    spec_sha: A,
    acceptance_sha: A,
    payload: JSON.stringify({ acceptance_text: "Избранные модели сохраняются между сессиями", spec_sha: A }),
  } as any);

  await runApprove("FEAT-1", "ok", {
    store,
    ctx: { cwd: d, isOwner: true, projectId: "p1" } as any,
    workGraphMode: "shadow",
    now: () => 1000,
  } as any);

  const contract = store.getSpecContract("FEAT-1");
  assert.ok(contract?.approval_id, "contract must be approved");
  assert.equal(contract?.spec_path, "docs/specs/acceptance/LEG-F-1.md");

  let err: any = null;
  try {
    await verifySpecBeforeCodeGate({ taskKey: "FEAT-1", role: "executor", store, cmd, repoRoot: d, workGraphMode: "shadow", task: store.getTask("FEAT-1") });
  } catch (e) {
    err = e;
  }
  assert.equal(err, null, "verifySpecBeforeCodeGate must pass after owner approval");
});

test("§31.9 Opus Audit Round 5 Blocker 2: mechanical contract requires non-empty basis and is checked by reviewer", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const { d, A, P } = makeAuditR5Repo();
  const { cmd } = initGitRepo(d);

  store.saveSpecContract({
    taskKey: "MECH-1",
    kind: "mechanical",
    mechanicalBasis: "Refactoring without changes",
    approvalId: "appr:p1:MECH-1:base:1000",
  });

  // verifySpecBeforeCodeGate passes with basis
  await verifySpecBeforeCodeGate({ taskKey: "MECH-1", role: "executor", store, cmd, repoRoot: d, workGraphMode: "strict" });

  // verifyReleaseDocumentsGate in strict mode requires review
  let err: any = null;
  try {
    await verifyReleaseDocumentsGate({ taskKey: "MECH-1", store, cmd, repoRoot: d, publishedSha: P, workGraphMode: "strict" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "strict mode release without review should fail for mechanical task");

  // With completed review delegation, release succeeds
  const delRow = db.prepare(`INSERT INTO delegations (task_key, coordinator_thread_id, level, route, preset, provider, status, continue_from, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get("MECH-1", "thr_c", "review", "review-opus", "opus", "claude-code", "done", P, 1000, 1000) as { id: number };
  db.prepare("INSERT INTO events (kind, payload, created_at) VALUES (?, ?, ?)").run("review.verdict", JSON.stringify({ delegationId: delRow.id, verdict: "OK", blockers: 0 }), 1000);
  await verifyReleaseDocumentsGate({ taskKey: "MECH-1", store, cmd, repoRoot: d, publishedSha: P, workGraphMode: "strict" });
});

test("§31.9 Opus Audit Round 6 Blocker 1: real in-flight legacy tasks (feature, fix, simple) at release in shadow pass gate", async () => {
  for (const route of ["feature", "fix", "simple"] as const) {
    const db = new Database(":memory:");
    for (const m of MIGRATIONS) db.exec(m);
    const store = new DelegationStore(db);
    const key = `LEG-${route.toUpperCase()}-1`;
    const d = makeTempDir(`audit-r6-b1-${route}-`);
    const { run, cmd } = initGitRepo(d);
    mkdirSync(join(d, "docs/specs/acceptance"), { recursive: true });
    writeFileSync(join(d, `docs/specs/acceptance/${key}.md`), "acc\n");
    run(["add", "."]);
    run(["commit", "-qm", "acc"]);
    const A = run(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(d, "code.ts"), "x\n");
    run(["add", "."]);
    run(["commit", "-qm", "code"]);
    const P = run(["rev-parse", "HEAD"]).trim();

    store.insertTask({ taskKey: key, projectId: "p1", coordinatorThreadId: "thr_c", route, level: "complex", confirmationMode: "manual" } as any);
    store.updateTask(key, {
      node: "release",
      status: "running",
      acceptance_sha: A,
      payload: JSON.stringify({ acceptance_text: "Free acceptance text", review_verdict: "OK", code_done: true }),
    } as any);
    const c = resolveTaskSpecContract(key, store, undefined, { forRelease: true, targetSha: P });
    assert.ok(c, `contract resolved for ${route}`);
    assert.ok(c.approvalId, `approvalId resolved for ${route}`);
    await verifyReleaseDocumentsGate({ taskKey: key, store, cmd, repoRoot: d, publishedSha: P, workGraphMode: "shadow" });
  }
});

test("§31.9 Opus Audit Round 6 Blocker 2: caller-supplied contract with fake or unapproved approvalId is rejected", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const key = "FAV-1";
  const { d, P } = makeAuditR5Repo();
  const { cmd } = initGitRepo(d);
  store.insertTask({ taskKey: key, projectId: "p1", coordinatorThreadId: "thr_c", route: "feature", level: "complex", confirmationMode: "manual" } as any);
  store.updateTask(key, { node: "code", status: "running", payload: JSON.stringify({ acceptance_text: "Favorite models" }) } as any);

  // Fake approvalId format rejected
  await assert.rejects(
    verifySpecBeforeCodeGate({
      taskKey: key, role: "executor", store, cmd, repoRoot: d, workGraphMode: "shadow", task: store.getTask(key),
      contract: { kind: "mechanical", mechanicalBasis: "x", approvalId: "whatever" },
    }),
    /spec-gate-violation/,
  );

  // Unapproved contract on manual task rejected even with valid appr: prefix
  await assert.rejects(
    verifySpecBeforeCodeGate({
      taskKey: key, role: "executor", store, cmd, repoRoot: d, workGraphMode: "shadow", task: store.getTask(key),
      contract: { kind: "behavior_change", specPath: "docs/specs/acceptance/LEG-F-1.md", specSha: P, approvalId: `appr:p1:${key}:${P}:1` },
    }),
    /spec-gate-violation/,
  );
});

test("§31.9 Opus Audit Round 6 Blocker 2 / R6-3: owner-approved contract cannot be overwritten by caller while keeping owner approval_id", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.saveSpecContract({ taskKey: "OWN-1", kind: "behavior_change", specPath: "docs/specs/x.md", specSha: "a".repeat(40), approvalId: "appr:p1:OWN-1:" + "a".repeat(40) + ":1" }, 1);
  const existing = store.getSpecContract("OWN-1");
  const caller = { kind: "mechanical" as const, mechanicalBasis: "rename" };
  const approvalId = (caller as any).approvalId ?? existing?.approval_id;
  store.saveSpecContract({ ...caller, taskKey: "OWN-1", projectId: "p1", approvalId } as any, 2);
  const after = store.getSpecContract("OWN-1");
  assert.equal(after?.kind, "behavior_change", "owner-approved kind must not be replaced by caller");
});

test("§31.9 Opus Audit Round 6 Non-blocker 3 / R6-4: simple task with payload mechanical_basis + free acceptance_text resolves as mechanical", () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.insertTask({ taskKey: "S-1", projectId: "p1", coordinatorThreadId: "thr_c", route: "simple", level: "simple", confirmationMode: "auto" } as any);
  const c = resolveTaskSpecContract("S-1", store, { acceptance_text: "переименовать функцию", mechanical_basis: "rename only" });
  assert.equal(c?.kind, "mechanical");
});

test("§31.9 Opus Audit Round 6 Non-blocker 2 / R6-5: mechanical release in shadow requires review verdict", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const { d, P } = makeAuditR5Repo();
  const { cmd } = initGitRepo(d);
  store.saveSpecContract({ taskKey: "M-1", kind: "mechanical", mechanicalBasis: "x", approvalId: "appr:p1:M-1:base:1" }, 1);
  await assert.rejects(
    verifyReleaseDocumentsGate({ taskKey: "M-1", store, cmd, repoRoot: d, publishedSha: P, workGraphMode: "shadow" }),
    /spec-gate-violation/,
    "shadow must require review verdict",
  );
});

test("§31.9 Opus Audit Round 6 Blocker 4 / R6-6: multi-doc spec commit stores all spec docs + ADR, verifies at release", async () => {
  const d = makeTempDir("orch-r6b-");
  const { run, cmd } = initGitRepo(d);
  mkdirSync(join(d, "docs/specs/acceptance"), { recursive: true });
  mkdirSync(join(d, "docs/adr"), { recursive: true });
  writeFileSync(join(d, "docs/specs/acceptance/F-1.md"), "acc\n");
  run(["add", "."]);
  run(["commit", "-qm", "acc"]);
  const A = run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(d, "docs/adr/0001-x.md"), "adr\n");
  writeFileSync(join(d, "docs/specs/a-graph.md"), "a\n");
  writeFileSync(join(d, "docs/specs/b-release.md"), "b\n");
  run(["add", "."]);
  run(["commit", "-qm", "spec"]);
  const S = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.insertTask({ taskKey: "F-1", projectId: "p1", coordinatorThreadId: "thr_c", route: "feature", level: "complex", confirmationMode: "manual" } as any);
  store.updateTask("F-1", { node: "owner_gate", status: "waiting_approval", spec_sha: S, acceptance_sha: A, payload: JSON.stringify({ acceptance_text: "free text", spec_sha: S }) } as any);
  await runApprove("F-1", "ok", { store, ctx: { cwd: d, isOwner: true, projectId: "p1" } as any, workGraphMode: "shadow", now: () => 1000 } as any);

  const c = store.getSpecContract("F-1");
  assert.ok(c?.spec_path?.includes("docs/specs/a-graph.md"), "first spec stored");
  assert.ok(c?.spec_path?.includes("docs/specs/b-release.md"), "second spec stored");
  assert.equal(c?.adr_path, "docs/adr/0001-x.md", "ADR path stored");
  assert.equal(c?.is_architectural, 1, "is_architectural set");

  // Deleting ADR and changing second spec at merge must block release
  rmSync(join(d, "docs/adr/0001-x.md"));
  writeFileSync(join(d, "docs/specs/b-release.md"), "CHANGED\n");
  writeFileSync(join(d, "code.ts"), "x\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "code+merge"]);
  const P = run(["rev-parse", "HEAD"]).trim();
  store.updateTask("F-1", { node: "release", status: "running" } as any);

  await assert.rejects(
    verifyReleaseDocumentsGate({ taskKey: "F-1", store, cmd, repoRoot: d, publishedSha: P, workGraphMode: "shadow" }),
    /spec-gate-violation/,
    "ADR deleted / 2nd spec changed at merge must block release",
  );
});

test("§31.9 Opus Audit Round 7 Blocker 1 / R7-1: multi-doc owner-approved spec passes pre-code gate on unchanged base", async () => {
  const d = makeTempDir("orch-r7-multi-");
  const { run, cmd } = initGitRepo(d);
  mkdirSync(join(d, "docs/specs/acceptance"), { recursive: true });
  mkdirSync(join(d, "docs/adr"), { recursive: true });
  writeFileSync(join(d, "docs/specs/acceptance/F-1.md"), "acc\n");
  run(["add", "."]); run(["commit", "-qm", "acc"]);
  const A = run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(d, "docs/adr/0001-x.md"), "adr\n");
  writeFileSync(join(d, "docs/specs/a-graph.md"), "a\n");
  writeFileSync(join(d, "docs/specs/b-release.md"), "b\n");
  run(["add", "."]); run(["commit", "-qm", "spec"]);
  const S = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:"); for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.insertTask({ taskKey: "F-1", projectId: "p1", coordinatorThreadId: "thr_c", route: "feature", level: "complex", confirmationMode: "manual" } as any);
  store.updateTask("F-1", { node: "owner_gate", status: "waiting_approval", spec_sha: S, acceptance_sha: A, payload: JSON.stringify({ acceptance_text: "free text", spec_sha: S }) } as any);
  await runApprove("F-1", "ok", { store, ctx: { cwd: d, isOwner: true, projectId: "p1" } as any, workGraphMode: "shadow", now: () => 1000 } as any);

  store.updateTask("F-1", { node: "code", status: "running" } as any);
  // Pre-code gate must PASS without throwing spec-gate-violation for multi-file spec
  await assert.doesNotReject(
    verifySpecBeforeCodeGate({
      taskKey: "F-1",
      role: "executor",
      level: "complex",
      store,
      cmd,
      repoRoot: d,
      baseSha: S,
      workGraphMode: "shadow",
      task: store.getTask("F-1"),
    }),
  );
});

test("§31.9 Opus Audit Round 7 Blocker 2 / R7-2: watchdog reissue checks contract without failing on missing cmd", async () => {
  const db = new Database(":memory:"); for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const { createWatchdog } = await import("../src/watchdog.js");
  const { parsePolicy } = await import("../src/policy.js");

  const policyLoad = parsePolicy(JSON.stringify({
    version: 1,
    limits: { maxActive: 5 },
    levels: {
      complex: { chain: ["c1", "c2"], autoFallback: true },
    },
    routes: {
      c1: { preset: "p1", provider: "pv1" },
      c2: { preset: "p2", provider: "pv2" },
    },
  }));

  // 1. Task without approved contract in shadow mode: watchdog refuses before store.reissue
  store.insertTask({
    taskKey: "NO-APP-1",
    projectId: "p1",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "manual",
  } as any);

  const row = store.insert({
    taskKey: "NO-APP-1",
    projectId: "p1",
    coordinatorThreadId: "thr_coord",
    level: "complex",
    route: "c1",
    preset: "p1",
    provider: "pv1",
  });
  store.setStatus(row.id, "running");
  db.prepare("UPDATE delegations SET thread_id = ? WHERE id = ?").run("thr_fake", row.id);

  let dispatched = false;
  const wd = createWatchdog({
    store,
    loadPolicy: async () => policyLoad,
    dispatch: async () => { dispatched = true; return { ok: true } as any; },
    threads: { get: async () => ({ id: "thr_fake", status: "idle" }), output: async () => ({ output: "" }), stop: async () => {} } as any,
    workGraphMode: () => "shadow",
    enqueue: (fn: any) => fn(),
  } as any);

  await wd.onTurnFailed({ threadId: "thr_fake", errorInfo: { category: "rate-limit" } });

  const delegations = store.delegationsByTask("NO-APP-1");
  assert.equal(delegations.length, 1, "no new delegation row should be created");
  assert.equal(dispatched, false, "no dispatch should be launched");
  const delRow = store.get(row.id);
  const setupErrors = delRow?.setup_errors ? JSON.parse(delRow.setup_errors) : [];
  assert.ok(setupErrors.some((e: any) => e.step === "spec-before-code-gate"), "spec-before-code-gate error recorded in setupErrors");
});

test("§31.9 Opus Audit Round 7 Blocker 3 / R7-3: executor gate on task at node=release without contract is rejected", async () => {
  const db = new Database(":memory:"); for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.insertTask({ taskKey: "R-1", projectId: "p1", coordinatorThreadId: "thr_c", route: "feature", level: "complex", confirmationMode: "auto" } as any);
  store.updateTask("R-1", { node: "release", status: "running" } as any);

  // Even when task is at node=release, an executor without contract MUST be rejected
  await assert.rejects(
    verifySpecBeforeCodeGate({ taskKey: "R-1", role: "executor", level: "complex", store, cmd: undefined, repoRoot: "", workGraphMode: "shadow", task: store.getTask("R-1") }),
    /spec-gate-violation/,
    "executor at release node without contract must be rejected",
  );
});

test("§31.9 Opus Audit Round 8 Non-blocker 5 / R7-4: sectionExistsInMarkdown requires heading or symbol, ignores substring in text", async () => {
  const { sectionExistsInMarkdown } = await import("../src/spec-gate.js");

  // Valid matches
  assert.equal(sectionExistsInMarkdown("# Title\n\n## §2 Core Requirements\n\nSome text.", "§2"), true, "matches ## §2");
  assert.equal(sectionExistsInMarkdown("# Title\n\n## 2 Core Requirements\n\nSome text.", "§2"), true, "matches ## 2 with §2 query");
  assert.equal(sectionExistsInMarkdown("# Title\n\n## 2 Core Requirements\n\nSome text.", "2"), true, "matches ## 2 with 2 query");
  assert.equal(sectionExistsInMarkdown("# Title\n\n### §5.1 Details\n\nSome text.", "§5.1"), true, "matches ### §5.1");
  assert.equal(sectionExistsInMarkdown("# Title\n\n### 5.1 Details\n\nSome text.", "5.1"), true, "matches ### 5.1");

  // False matches that MUST be rejected
  assert.equal(sectionExistsInMarkdown("# Title\n\n## §20 Other\n\nSome text.", "§2"), false, "must NOT match §20 when looking for §2");
  assert.equal(sectionExistsInMarkdown("# Title\n\nHere is 200 items and error code 2 in a sentence.\n", "§2"), false, "must NOT match random number 2 in paragraph with §2");
  assert.equal(sectionExistsInMarkdown("# Title\n\nHere is 200 items and error code 2 in a sentence.\n", "2"), false, "must NOT match random number 2 in paragraph with 2");
  assert.equal(sectionExistsInMarkdown("# Title\n\nRelease version v5.1 is out.\n", "§5.1"), false, "must NOT match v5.1 in paragraph");
  assert.equal(sectionExistsInMarkdown("# Title\n\n### §5.1.2 Sub-details\n", "§5.1"), false, "must NOT match §5.1.2 when looking for §5.1");
});

test("§31.9 Opus Audit Round 8 Blocker 1: CHANGES review verdict followed by pruneEvents returns null", async () => {
  const db = new Database(":memory:"); for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const SHA = "a".repeat(40);
  const del = store.insert({
    taskKey: "REV-CH-1",
    projectId: "p1",
    coordinatorThreadId: "thr_c",
    level: "review",
    route: "r",
    preset: "p",
    provider: "pr",
    continueFrom: SHA,
  });
  store.setStatus(del.id, "running");
  store.setStatusIf(del.id, "running", "done", {
    reviewVerdict: { verdict: "CHANGES", blockers: 3 },
  });

  // 1. Before pruning, verdict event has CHANGES -> getLatestAcceptedReview returns null
  assert.equal(store.getLatestAcceptedReview("REV-CH-1", SHA), null);

  // 2. Prune events (delete review.verdict event) -> must STILL return null, NOT treat done delegation as accepted!
  db.prepare("DELETE FROM events WHERE kind = 'review.verdict'").run();
  assert.equal(store.getLatestAcceptedReview("REV-CH-1", SHA), null, "after pruning events, review without OK verdict must NOT be accepted");
});

test("§31.9 Opus Audit Round 9 Blocker 1: spec in coordinator HEAD but missing on origin/main is rejected without --from", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-coord-head-");
  const { run, cmd } = initGitRepo(repoDir);

  // Set up origin/main branch pointing to initial commit
  run(["branch", "origin/main"]);

  // Now create a coordinator commit in HEAD with a spec (not pushed to origin/main)
  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/unpushed.md"), "# Unpushed Spec\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: local spec in coordinator branch"]);
  const localSpecSha = run(["rev-parse", "HEAD"]).trim();

  store.saveSpecContract({
    taskKey: "COORD-HEAD-1",
    projectId: "p1",
    kind: "behavior_change",
    specPath: "docs/specs/unpushed.md",
    specSha: localSpecSha,
    approvalId: `appr:p1:COORD-HEAD-1:${localSpecSha.slice(0, 12)}:1`,
  });

  // Without --from (preparedBaseSha = undefined), gate checks origin/main where spec does not exist -> REJECTS!
  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "COORD-HEAD-1",
        role: "executor",
        level: "complex",
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /отсутствует в базовом коммите|не найден в истории базовой ветки/);
      return true;
    },
  );

  // With explicit --from HEAD (or localSpecSha), executor starts from that base -> PASSES!
  await verifySpecBeforeCodeGate({
    taskKey: "COORD-HEAD-1",
    role: "executor",
    level: "complex",
    store,
    cmd,
    repoRoot: repoDir,
    preparedBaseSha: "HEAD",
    workGraphMode: "shadow",
  });
});

test("§31.9 Opus Audit Round 9 Blocker 2: watchdog respects specBeforeCode: false in policy or project in shadow mode", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const { createWatchdog } = await import("../src/watchdog.js");
  const { parsePolicy } = await import("../src/policy.js");

  const policyLoad = parsePolicy(JSON.stringify({
    version: 1,
    limits: { maxActive: 5 },
    levels: {
      complex: { chain: ["c1", "c2"], autoFallback: true },
    },
    routes: {
      c1: { preset: "p1", provider: "pv1" },
      c2: { preset: "p2", provider: "pv2" },
    },
    specBeforeCode: false,
  }));

  store.insertTask({
    taskKey: "NO-SBC-1",
    projectId: "p1",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "manual",
  } as any);

  const row = store.insert({
    taskKey: "NO-SBC-1",
    projectId: "p1",
    coordinatorThreadId: "thr_coord",
    level: "complex",
    route: "c1",
    preset: "p1",
    provider: "pv1",
  });
  store.setStatus(row.id, "running");
  db.prepare("UPDATE delegations SET thread_id = ? WHERE id = ?").run("thr_fake", row.id);

  let dispatched = false;
  const wd = createWatchdog({
    store,
    loadPolicy: async () => policyLoad,
    dispatch: async () => { dispatched = true; return { threadId: "thr_new", status: "running", setupErrors: [] } as any; },
    threads: { get: async () => ({ id: "thr_fake", status: "idle" }), output: async () => ({ output: "" }), stop: async () => {} } as any,
    workGraphMode: () => "shadow",
    enqueue: (fn: any) => fn(),
  } as any);

  // Task has NO contract, but specBeforeCode is false -> watchdog must NOT refuse reissue!
  await wd.onTurnFailed({ threadId: "thr_fake", errorInfo: { category: "rate-limit" } });

  const updated = store.get(row.id)!;
  assert.equal(updated.status, "reissued");
  const delegations = store.delegationsByTask("NO-SBC-1");
  assert.equal(delegations.length, 2, "new delegation row should be created");
  assert.equal(dispatched, true, "dispatch should be launched");
  const setupErrors = updated.setup_errors ? JSON.parse(updated.setup_errors) : [];
  assert.equal(setupErrors.some((e: any) => e.step === "spec-before-code-gate"), false, "must not record spec-before-code-gate error when disabled");
});

test("§31.9 Opus Audit Round 9 Blocker 3: verifyReleaseDocumentsGate rejects missing specSha, 'base' specSha, and weird kind", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const repoDir = makeTempDir("orch-spec-release-blockers-");
  const { run, cmd } = initGitRepo(repoDir);

  mkdirSync(join(repoDir, "docs/specs"), { recursive: true });
  writeFileSync(join(repoDir, "docs/specs/test.md"), "# Spec\n");
  run(["add", "."]);
  run(["commit", "-m", "docs: add spec"]);
  const pubSha = run(["rev-parse", "HEAD"]).trim();

  // 3a. specSha points to a non-existent commit in repo -> rejects
  await assert.rejects(
    async () => {
      await verifyReleaseDocumentsGate({
        taskKey: "REL-NONEXISTENT-1",
        store,
        cmd,
        repoRoot: repoDir,
        publishedSha: pubSha,
        contract: {
          kind: "behavior_change",
          specPath: "docs/specs/test.md",
          specSha: "deadbeef".repeat(5),
          approvalId: "appr:p1:REL-NONEXISTENT-1:spec:1",
        },
        workGraphMode: "strict",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /не найден в репозитории/);
      return true;
    },
  );

  // 3b. specSha = "base" -> rejects
  await assert.rejects(
    async () => {
      await verifyReleaseDocumentsGate({
        taskKey: "REL-BASE-1",
        store,
        cmd,
        repoRoot: repoDir,
        publishedSha: pubSha,
        contract: {
          kind: "behavior_change",
          specPath: "docs/specs/test.md",
          specSha: "base",
          approvalId: "appr:p1:REL-BASE-1:base:1",
        },
        workGraphMode: "strict",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /отсутствует или недействителен коммит спецификации/);
      return true;
    },
  );

  // 3c. kind = "weird" -> rejects
  await assert.rejects(
    async () => {
      await verifyReleaseDocumentsGate({
        taskKey: "REL-WEIRD-1",
        store,
        cmd,
        repoRoot: repoDir,
        publishedSha: pubSha,
        contract: {
          kind: "weird" as any,
          specPath: "docs/specs/test.md",
          specSha: pubSha,
          approvalId: "appr:p1:REL-WEIRD-1:spec:1",
        },
        workGraphMode: "strict",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /неизвестный тип задачи "weird"/);
      return true;
    },
  );
});

test("§31.9 Acceptance Scenario 1 (NET-46): in auto mode, positive spec review binds to recorded range, even after target branch advances", async () => {
  const d = makeTempDir("orch-net46-");
  const { run, cmd } = initGitRepo(d);
  const baseSha = run(["rev-parse", "HEAD"]).trim();

  mkdirSync(join(d, "docs/specs"), { recursive: true });
  writeFileSync(join(d, "docs/specs/test-spec.md"), "# Spec\n§1: requirement\n");
  run(["add", "."]);
  run(["commit", "-qm", "docs: test spec"]);
  const specSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  store.insertTask({
    taskKey: "NET-46",
    projectId: "proj_eshr98jkqq",
    coordinatorThreadId: "thr_aitmf7kjfx",
    route: "feature",
    level: "complex",
    node: "start",
    status: "queued",
    confirmationMode: "auto",
  } as any);

  // Record spec review delegation #1756 on exact range baseSha..specSha
  const del = store.insert({
    taskKey: "NET-46",
    projectId: "proj_eshr98jkqq",
    coordinatorThreadId: "thr_aitmf7kjfx",
    level: "review",
    route: "review-opus",
    preset: "opus55-review",
    provider: "claude-code",
    continueFrom: specSha,
    attach: JSON.stringify({
      kind: "spec_review",
      taskKey: "NET-46",
      projectId: "proj_eshr98jkqq",
      repo: d,
      baseSha,
      headSha: specSha,
      paths: ["docs/specs/test-spec.md"],
      from: specSha,
    }),
  });
  store.setStatus(del.id, "running");
  store.setStatusIf(del.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  });

  // Target branch advances!
  run(["checkout", "main"]);
  writeFileSync(join(d, "adv.txt"), "target branch advanced\n");
  run(["add", "."]);
  run(["commit", "-qm", "feat: advance target branch"]);

  // Verify spec gate passes for executor in shadow mode using fixed recorded range
  await verifySpecBeforeCodeGate({
    taskKey: "NET-46",
    role: "executor",
    store,
    cmd,
    repoRoot: d,
    workGraphMode: "shadow",
    baseSha: specSha,
    preparedBaseSha: specSha,
  });

  // Contract was persisted to task_spec_contracts
  const stored = store.getSpecContract("NET-46");
  assert.ok(stored, "stored contract must exist in task_spec_contracts");
  assert.equal(stored?.spec_sha, specSha);
  assert.equal(stored?.project_id, "proj_eshr98jkqq");
  assert.ok(stored?.approval_id?.startsWith("appr:proj_eshr98jkqq:NET-46:"));

  // Task payload was also updated
  const updatedTask = store.getTask("NET-46");
  assert.equal(updatedTask?.spec_sha, specSha);
  const pl = JSON.parse(updatedTask?.payload || "{}");
  assert.equal(pl.approval_id, stored?.approval_id);
});

test("§31.9 Incident NET-46: ordinary code review does NOT approve a spec", async () => {
  const d = makeTempDir("orch-net46-code-");
  const { run, cmd } = initGitRepo(d);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src/server.ts"), "export const a = 1;\n");
  run(["add", "."]);
  run(["commit", "-qm", "feat: code change"]);
  const codeSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  store.insertTask({
    taskKey: "NET-47",
    projectId: "proj_eshr98jkqq",
    coordinatorThreadId: "thr_aitmf7kjfx",
    route: "feature",
    level: "complex",
    node: "start",
    status: "queued",
    confirmationMode: "auto",
  } as any);

  // Review of code change
  const del = store.insert({
    taskKey: "NET-47",
    projectId: "proj_eshr98jkqq",
    coordinatorThreadId: "thr_aitmf7kjfx",
    level: "review",
    route: "review-opus",
    preset: "opus55-review",
    provider: "claude-code",
    continueFrom: codeSha,
    attach: JSON.stringify({ paths: ["src/server.ts"], from: codeSha }),
  });
  store.setStatus(del.id, "running");
  store.setStatusIf(del.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  });

  await assert.rejects(
    verifySpecBeforeCodeGate({
      taskKey: "NET-47",
      role: "executor",
      store,
      cmd,
      repoRoot: d,
      workGraphMode: "shadow",
      baseSha: codeSha,
      preparedBaseSha: codeSha,
    }),
    /spec-gate-violation/,
    "code review must NOT approve spec",
  );
  assert.equal(store.getSpecContract("NET-47"), null);
});

test("§31.9 Incident NET-46: manual confirmation mode requires explicit owner approve", async () => {
  const d = makeTempDir("orch-net46-man-");
  const { run, cmd } = initGitRepo(d);
  mkdirSync(join(d, "docs/specs"), { recursive: true });
  writeFileSync(join(d, "docs/specs/test-spec.md"), "# Spec\n§1: requirement\n");
  run(["add", "."]);
  run(["commit", "-qm", "docs: test spec"]);
  const specSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  store.insertTask({
    taskKey: "NET-48",
    projectId: "proj_eshr98jkqq",
    coordinatorThreadId: "thr_aitmf7kjfx",
    route: "feature",
    level: "complex",
    node: "start",
    status: "queued",
    confirmationMode: "manual",
  } as any);

  const del = store.insert({
    taskKey: "NET-48",
    projectId: "proj_eshr98jkqq",
    coordinatorThreadId: "thr_aitmf7kjfx",
    level: "review",
    route: "review-opus",
    preset: "opus55-review",
    provider: "claude-code",
    continueFrom: specSha,
    attach: JSON.stringify({ paths: [], from: specSha }),
  });
  store.setStatus(del.id, "running");
  store.setStatusIf(del.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  });

  await assert.rejects(
    verifySpecBeforeCodeGate({
      taskKey: "NET-48",
      role: "executor",
      store,
      cmd,
      repoRoot: d,
      workGraphMode: "shadow",
      baseSha: specSha,
      preparedBaseSha: specSha,
    }),
    /spec-gate-violation/,
    "manual mode must reject without owner approve",
  );
});

test("§31.9 Alignment: gate and spawn share exact immutable SHA when origin/HEAD and preset.baseBranch diverge", async () => {
  const remoteDir = makeTempDir("orch-remote-diverge-");
  const localDir = makeTempDir("orch-local-diverge-");

  // Init bare/origin repo
  const runRemote = (args: string[]) => execFileSync("git", args, { cwd: remoteDir, encoding: "utf8" });
  runRemote(["init", "-b", "main"]);
  runRemote(["config", "user.name", "Tester"]);
  runRemote(["config", "user.email", "test@test.local"]);
  writeFileSync(join(remoteDir, "README.md"), "# Main\n");
  runRemote(["add", "."]);
  runRemote(["commit", "-qm", "initial main"]);
  const mainSha = runRemote(["rev-parse", "HEAD"]).trim();

  // Create dev branch with spec in remote
  runRemote(["checkout", "-b", "dev"]);
  mkdirSync(join(remoteDir, "docs/specs"), { recursive: true });
  writeFileSync(join(remoteDir, "docs/specs/DIV-1.md"), "# Spec DIV-1\n§1: requirement\n");
  runRemote(["add", "."]);
  runRemote(["commit", "-qm", "docs: dev branch spec"]);
  const devSha = runRemote(["rev-parse", "HEAD"]).trim();
  runRemote(["checkout", "main"]);

  // Local clone pointing to remote
  const runLocal = (args: string[]) => execFileSync("git", args, { cwd: localDir, encoding: "utf8" });
  runLocal(["init", "-b", "main"]);
  runLocal(["remote", "add", "origin", remoteDir]);
  runLocal(["fetch", "origin"]);
  runLocal(["reset", "--hard", "origin/main"]);
  runLocal(["config", "user.name", "Tester"]);
  runLocal(["config", "user.email", "test@test.local"]);

  const cmdLocal: CmdRunner = {
    run: async (file, args, opts) => {
      try {
        const out = execFileSync(file, args, { cwd: opts?.cwd ?? localDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { exitCode: 0, stdout: out, stderr: "" };
      } catch (e: any) {
        return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    },
  };

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  store.saveSpecContract({
    taskKey: "DIV-1",
    projectId: "proj_div",
    kind: "behavior_change",
    specPath: "docs/specs/DIV-1.md",
    specSha: devSha,
    approvalId: "appr:proj_div:DIV-1:spec:1",
  });

  let capturedSpawnArgs: any = null;
  const mockThreads = {
    spawn: async (args: any) => {
      capturedSpawnArgs = args;
      return { id: "thr_exec_div" };
    },
  };

  const policy = parsePolicy(
    JSON.stringify({
      version: 1,
      specBeforeCode: true,
      routes: {
        "dev-route": { preset: "dev-preset", provider: "mock" },
      },
      levels: {
        complex: { chain: ["dev-route"] },
      },
      presets: {
        "dev-preset": { baseBranch: "dev" },
      },
    }),
  );

  const fakeCli: BbCli = {
    run: async (args: string[]) => {
      if (args[0] === "tasks" && args[1] === "show") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            task: { id: "task_div_1", key: "DIV-1", title: "Task DIV-1", description: "desc", status: "in_progress" },
            project: { id: "proj_div", linkedBbProjectId: "proj_div_bb" },
            comments: [],
            subtasks: [],
            attachments: [],
          }),
          stderr: "",
        };
      }
      if (args[0] === "tasks" && args[1] === "preset" && args[2] === "show") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            preset: {
              providerId: "mock-prov",
              permissionMode: "full",
              environmentKind: "host",
              baseBranch: "dev",
              machineId: "host_1",
            },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };

  const res = await runDelegate(
    {
      taskKey: "DIV-1",
      level: "complex",
      caller: {
        threadId: "thr_coord",
        parentThreadId: null,
        title: "coordinator",
        originPluginId: null,
        projectId: "proj_div",
      },
    },
    {
      store,
      policy: () => policy.policy,
      loadPolicy: async () => policy,
      bbCli: fakeCli,
      cmd: cmdLocal,
      repoRoot: localDir,
      workGraphMode: "shadow",
      threads: mockThreads as any,
      primaryHostId: async () => "host_1",
      probes: { roleByThreadId: () => "orchestrator" },
    } as any,
  );

  assert.equal(res.status, "running");
  assert.ok(capturedSpawnArgs, "threads.spawn must be called");
  // Both gate and spawn must see exact devSha, NOT mainSha
  assert.equal(capturedSpawnArgs.environment?.workspace?.baseBranch?.name, devSha);
  assert.notEqual(devSha, mainSha);
  const del = store.get(res.delegationId)!;
  assert.equal(del.continue_from, null);
});

test("§31.9 Round 11: round 2 delegation preserves continue_from from round 1", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const dir = makeTempDir("r2-preserves-");
  const { cmd } = initGitRepo(dir);

  const del1 = store.insert({
    taskKey: "R2-1",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "simple",
    provider: "provider",
    round: 1,
    continueFrom: "origin/main",
  });
  store.setStatus(del1.id, "running");
  store.setRoundResult(del1.id, {
    branch: "bb/r2-1",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    commits: 1,
    dirty: false,
  });
  store.setStatus(del1.id, "done");

  const pol = parsePolicy(
    JSON.stringify({
      version: 1,
      presets: {
        simple: {
          provider: "provider",
          baseBranch: "main",
        },
      },
      routes: {
        simple: {
          preset: "simple",
          provider: "provider",
        },
      },
      levels: {
        simple: {
          chain: ["simple"],
        },
      },
    }),
  );

  let capturedSpawnArgs: any = null;
  const res = await runDelegate(
    {
      taskKey: "R2-1",
      level: "simple",
      caller: {
        threadId: "thr_coord",
        parentThreadId: null,
        title: "coordinator",
        originPluginId: null,
        projectId: "proj_1",
      },
    },
    {
      store,
      policy: () => pol.policy,
      loadPolicy: async () => pol,
      bbCli: {
        run: async (args: string[]) => {
          if (args[0] === "tasks" && args[1] === "preset") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ preset: { providerId: "p", permissionMode: "read", environmentKind: "project-default" } }),
              stderr: "",
            };
          }
          if (args[0] === "tasks" && args[1] === "show") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                task: { id: "t_1", key: "R2-1", title: "Task" },
                project: { id: "proj_1", linkedBbProjectId: "proj_1_bb" },
              }),
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
      },
      threads: {
        spawn: async (args: any) => {
          capturedSpawnArgs = args;
          return { id: "thr_exec_2" };
        },
        update: async () => {},
      },
      probes: { roleByThreadId: () => "orchestrator" },
      cmd,
      repoRoot: dir,
    } as any,
  );

  assert.equal(res.status, "running");
  const del2 = store.get(res.delegationId)!;
  assert.equal(del2.round, 2);
  assert.equal(del2.continue_from, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("§31.9 Round 11: NET-46 auto-acceptance preserves altersContract and isArchitectural constraints", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const dir = makeTempDir("net46-auto-");
  const { run, cmd } = initGitRepo(dir);

  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/auto-alt.md"), "# Spec\n§1: content\n");
  run(["add", "."]);
  run(["commit", "-m", "spec commit"]);
  const specCommit = run(["rev-parse", "HEAD"]).trim();

  // Task in auto confirmation mode with altersContract = true
  store.insertTask({
    taskKey: "AUTO-ALT",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "complex",
    confirmationMode: "auto",
    payload: JSON.stringify({
      spec_path: "docs/specs/auto-alt.md",
      spec_section: "§1",
      alters_contract: true,
    }),
  });

  // Recorded positive spec review with explicit spec review range
  const baseSha = run(["rev-parse", "HEAD~1"]).trim();
  const rev = store.insert({
    taskKey: "AUTO-ALT",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review-gemini",
    preset: "gemini",
    provider: "agy",
    round: 1,
    continueFrom: specCommit,
    attach: JSON.stringify({
      kind: "spec_review",
      taskKey: "AUTO-ALT",
      projectId: "proj_1",
      repo: dir,
      baseSha,
      headSha: specCommit,
      paths: ["docs/specs/auto-alt.md"],
    }),
  });
  store.setStatus(rev.id, "running");
  store.setStatusIf(rev.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  });

  const pol = parsePolicy(
    JSON.stringify({
      version: 1,
      presets: {
        devin: {
          provider: "acp-devin",
        },
      },
      routes: {
        devin: {
          preset: "devin",
          provider: "acp-devin",
        },
      },
      levels: {
        complex: {
          chain: ["devin"],
        },
      },
    }),
  );

  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "AUTO-ALT",
        role: "executor",
        noCode: false,
        level: "complex",
        store,
        cmd,
        policy: pol.policy,
        baseSha: specCommit,
        repoRoot: dir,
        workGraphMode: "shadow",
      });
    },
    (err: any) => {
      assert.match(err.message, /altersContract = true/);
      return true;
    },
  );
});

test("§31.9 Round 11: review of code commit modifying README is not accepted as spec review", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const dir = makeTempDir("code-rev-readme-");
  const { run, cmd } = initGitRepo(dir);

  // Commit 1: src/foo.ts
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/foo.ts"), "export const x = 1;\n");
  run(["add", "src/foo.ts"]);
  run(["commit", "-m", "feat: code"]);

  // Commit 2: README.md
  writeFileSync(join(dir, "README.md"), "# Updated Readme\n");
  run(["add", "README.md"]);
  run(["commit", "-m", "docs: readme"]);
  const revSha = run(["rev-parse", "HEAD"]).trim();

  store.insertTask({
    taskKey: "CODE-REV",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "complex",
    confirmationMode: "auto",
  });

  const rev = store.insert({
    taskKey: "CODE-REV",
    projectId: "proj_1",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review-gemini",
    preset: "gemini",
    provider: "agy",
    round: 1,
    continueFrom: revSha,
  });
  store.setStatus(rev.id, "running");
  store.setStatusIf(rev.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  });

  const found = await findAcceptedSpecReview({
    taskKey: "CODE-REV",
    store,
    cmd,
    repoRoot: dir,
  });

  assert.equal(found, null, "Code review modifying README must not be accepted as spec review");
});

test("§31.9 Round 11: release gate rejects bugfix when spec was modified during merge", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const dir = makeTempDir("fix-mod-");
  const { run, cmd } = initGitRepo(dir);

  const specPath = "docs/specs/spec.md";
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, specPath), "# Original Spec\n");
  run(["add", specPath]);
  run(["commit", "-m", "initial spec"]);
  const baseSha = run(["rev-parse", "HEAD"]).trim();

  // Commit on merge modifies the spec file
  writeFileSync(join(dir, specPath), "# Rewritten Spec Without Approval\n");
  run(["add", specPath]);
  run(["commit", "-m", "fix: unauthorized spec rewrite"]);
  const publishedSha = run(["rev-parse", "HEAD"]).trim();

  await assert.rejects(
    async () => {
      await verifyReleaseDocumentsGate({
        taskKey: "FIX-MOD",
        store,
        cmd,
        repoRoot: dir,
        publishedSha,
        workGraphMode: "strict",
        contract: {
          kind: "bugfix",
          specPath,
          specSection: "§1",
          specSha: baseSha,
          approvalId: "appr:proj:FIX-MOD:sha:123",
        },
      });
    },
    (err: any) => {
      assert.match(err.message, /была изменена при сведении ветки релиза/);
      return true;
    },
  );
});

test("§31.9 Round 12: project specBeforeCode with workGraph off leaves 0 delegations and does not block second call", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const dir = makeTempDir("r12-proj-spec-");
  const { cmd } = initGitRepo(dir);

  const pol = parsePolicy(
    JSON.stringify({
      version: 1,
      presets: {
        simple: { provider: "p" },
      },
      routes: {
        simple: { preset: "simple", provider: "p" },
      },
      levels: {
        simple: { chain: ["simple"] },
      },
    }),
  );

  const deps = {
    store,
    policy: () => pol.policy,
    loadPolicy: async () => pol,
    workGraphMode: "off",
    resolveProject: () => ({ excluded: false, specBeforeCode: true }),
    repoRoot: dir,
    cmd,
    threads: {
      spawn: async () => ({ id: "thr_exec" }),
      update: async () => ({}),
    },
    probes: { roleByThreadId: () => "orchestrator" },
    bbCli: {
      run: async (args: string[]) => {
        if (args[0] === "tasks" && args[1] === "show") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              task: { id: "t_1", key: "P-SPEC-1", title: "Task" },
              project: { id: "proj_1", linkedBbProjectId: "proj_1_bb" },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    },
  };

  // First call: must reject with spec-gate-violation
  await assert.rejects(
    async () => {
      await runDelegate(
        {
          taskKey: "P-SPEC-1",
          level: "simple",
          caller: {
            threadId: "thr_coord",
            parentThreadId: null,
            title: "coordinator",
            originPluginId: null,
            projectId: "proj_1",
          },
        },
        deps as any,
      );
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  // Store must have 0 rows
  assert.equal(store.delegationsByTask("P-SPEC-1").length, 0);

  // Second call: must STILL reject with spec-gate-violation (NOT task-already-delegated)
  await assert.rejects(
    async () => {
      await runDelegate(
        {
          taskKey: "P-SPEC-1",
          level: "simple",
          caller: {
            threadId: "thr_coord",
            parentThreadId: null,
            title: "coordinator",
            originPluginId: null,
            projectId: "proj_1",
          },
        },
        deps as any,
      );
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
  assert.equal(store.delegationsByTask("P-SPEC-1").length, 0);
});

test("§31.9 Round 12: shadow mode without repoRoot leaves 0 delegations and does not block second call", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const pol = parsePolicy(
    JSON.stringify({
      version: 1,
      presets: {
        simple: { provider: "p" },
      },
      routes: {
        simple: { preset: "simple", provider: "p" },
      },
      levels: {
        simple: { chain: ["simple"] },
      },
    }),
  );

  const deps = {
    store,
    policy: () => pol.policy,
    loadPolicy: async () => pol,
    workGraphMode: "shadow",
    repoRoot: undefined,
    cmd: undefined,
    threads: {
      spawn: async () => ({ id: "thr_exec" }),
      update: async () => ({}),
    },
    probes: { roleByThreadId: () => "orchestrator" },
    bbCli: {
      run: async (args: string[]) => {
        if (args[0] === "tasks" && args[1] === "show") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              task: { id: "t_1", key: "NO-REPO-1", title: "Task" },
              project: { id: "proj_1", linkedBbProjectId: "proj_1_bb" },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    },
  };

  // First call rejects with spec-gate-violation
  await assert.rejects(
    async () => {
      await runDelegate(
        {
          taskKey: "NO-REPO-1",
          level: "simple",
          caller: {
            threadId: "thr_coord",
            parentThreadId: null,
            title: "coordinator",
            originPluginId: null,
            projectId: "proj_1",
          },
        },
        deps as any,
      );
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );

  assert.equal(store.delegationsByTask("NO-REPO-1").length, 0);

  // Second call STILL rejects with spec-gate-violation (not task-already-delegated)
  await assert.rejects(
    async () => {
      await runDelegate(
        {
          taskKey: "NO-REPO-1",
          level: "simple",
          caller: {
            threadId: "thr_coord",
            parentThreadId: null,
            title: "coordinator",
            originPluginId: null,
            projectId: "proj_1",
          },
        },
        deps as any,
      );
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
  assert.equal(store.delegationsByTask("NO-REPO-1").length, 0);
});

test("§31.9 Round 12: bugfix contract without specSha and without baseSha rejects pre-code gate", async () => {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const dir = makeTempDir("r12-fix-no-sha-");
  const { cmd } = initGitRepo(dir);

  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "FIX-NO-SHA",
        role: "executor",
        level: "simple",
        store,
        cmd,
        repoRoot: dir,
        workGraphMode: "shadow",
        contract: {
          kind: "bugfix",
          specPath: "docs/specs/test.md",
          specSection: "§1",
          approvalId: "appr:p1:FIX-NO-SHA:sha:1",
        },
      });
    },
    (err: any) => {
      assert.match(err.message, /отсутствует или недействителен коммит спецификации/);
      return true;
    },
  );
});

test("§31.9 Round 13 Repro: branch with code in commit 1 and spec in commit 2 must NOT be accepted as spec review", async () => {
  const dir = makeTempDir("r13-repro-");
  const { run, cmd } = initGitRepo(dir);
  run(["update-ref", "refs/remotes/origin/main", "main"]);
  run(["checkout", "-qb", "feature"]);

  // Commit 1: code
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  run(["add", "."]);
  run(["commit", "-qm", "feat: code"]);

  // Commit 2: spec
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/s.md"), "# S\n");
  run(["add", "."]);
  run(["commit", "-qm", "docs: spec"]);
  const revSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const rev = store.insert({
    taskKey: "R13-1",
    projectId: "p",
    coordinatorThreadId: "c",
    level: "review",
    route: "r",
    preset: "x",
    provider: "y",
    round: 1,
    continueFrom: revSha,
  } as any);
  store.setStatus(rev.id, "running");
  store.setStatusIf(rev.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  const found = await findAcceptedSpecReview({
    taskKey: "R13-1",
    store,
    cmd,
    repoRoot: dir,
    baseBranch: "main",
  });
  assert.equal(found, null, "Branch review with code in commit 1 must NOT be accepted as a spec review");
});

test("§31.9 Round 13 Architect Negative: attach.from == head, code in commit 1, spec in commit 2 gives no auto-approval", async () => {
  const dir = makeTempDir("r13-arch-neg-");
  const { run, cmd } = initGitRepo(dir);
  run(["update-ref", "refs/remotes/origin/dev", "main"]);
  run(["checkout", "-qb", "feature-branch"]);

  // Commit 1: code change
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/lib.ts"), "export const lib = 42;\n");
  run(["add", "."]);
  run(["commit", "-qm", "feat: lib code"]);

  // Commit 2: spec change
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/lib.md"), "# Lib Spec\n");
  run(["add", "."]);
  run(["commit", "-qm", "docs: lib spec"]);
  const headSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  store.insertTask({
    taskKey: "ARCH-NEG-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    route: "fix",
    level: "complex",
    confirmationMode: "auto",
  });

  const rev = store.insert({
    taskKey: "ARCH-NEG-1",
    projectId: "proj_test",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review-gemini",
    preset: "gemini",
    provider: "agy",
    round: 1,
    continueFrom: headSha,
    attach: JSON.stringify({ paths: [], from: headSha }),
  } as any);
  store.setStatus(rev.id, "running");
  store.setStatusIf(rev.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  const found = await findAcceptedSpecReview({
    taskKey: "ARCH-NEG-1",
    store,
    cmd,
    repoRoot: dir,
    baseBranch: "dev",
  });
  assert.equal(found, null, "Review with code in history must not be accepted as spec review");

  // Gate must reject code launch since spec review was not approved
  await assert.rejects(
    async () => {
      await verifySpecBeforeCodeGate({
        taskKey: "ARCH-NEG-1",
        role: "executor",
        level: "complex",
        store,
        cmd,
        repoRoot: dir,
        workGraphMode: "shadow",
        baseBranchName: "dev",
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
});

test("§31.9 Round 13 Non-spec files (.sql, .json, .yml) in review are not accepted as spec review", async () => {
  const dir = makeTempDir("r13-sql-json-");
  const { run, cmd } = initGitRepo(dir);
  run(["update-ref", "refs/remotes/origin/main", "main"]);
  run(["checkout", "-qb", "feat-db"]);

  mkdirSync(join(dir, "migrations"), { recursive: true });
  writeFileSync(join(dir, "migrations/001.sql"), "CREATE TABLE t (id INT);\n");
  run(["add", "."]);
  run(["commit", "-qm", "db: migration"]);
  const revSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  const rev = store.insert({
    taskKey: "SQL-1",
    projectId: "p",
    coordinatorThreadId: "c",
    level: "review",
    route: "r",
    preset: "x",
    provider: "y",
    round: 1,
    continueFrom: revSha,
  } as any);
  store.setStatus(rev.id, "running");
  store.setStatusIf(rev.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  const found = await findAcceptedSpecReview({
    taskKey: "SQL-1",
    store,
    cmd,
    repoRoot: dir,
    baseBranch: "main",
  });
  assert.equal(found, null, "Review modifying SQL migration must NOT be accepted as spec review");
});

test("§31.9 Acceptance Scenario 3: missing recorded baseSha in old review requires explicit spec review and blocks executor spawn until verdict", async () => {
  const dir = makeTempDir("r14-scen3-");
  const { run, cmd } = initGitRepo(dir);
  const baseSha = run(["rev-parse", "HEAD"]).trim();

  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/scen3.md"), "# Spec\n§1: content\n");
  run(["add", "."]);
  run(["commit", "-qm", "docs: scen3 spec"]);
  const headSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  store.insertTask({
    taskKey: "SCEN3-1",
    projectId: "proj_scen3",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  });

  // Old review record without proven baseSha (attach has no baseSha or kind: "spec_review")
  const oldRev = store.insert({
    taskKey: "SCEN3-1",
    projectId: "proj_scen3",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review-opus",
    preset: "opus55-review",
    provider: "claude-code",
    round: 1,
    continueFrom: headSha,
    attach: JSON.stringify({ paths: [], from: headSha }),
  } as any);
  store.setStatus(oldRev.id, "running");
  store.setStatusIf(oldRev.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  let spawnCount = 0;
  const mockThreads = {
    spawn: async () => {
      spawnCount++;
      return { id: "thr_mock_scen3" };
    },
  };

  const pol = parsePolicy(
    JSON.stringify({
      version: 1,
      presets: {
        devin: { provider: "acp-devin", baseBranch: "main" },
        "opus55-review": { provider: "claude-code", baseBranch: "main" },
      },
      routes: {
        devin: { preset: "devin", provider: "acp-devin" },
        "review-opus": { preset: "opus55-review", provider: "claude-code" },
      },
      levels: {
        complex: { chain: ["devin"] },
        review: { chain: ["review-opus"] },
      },
    }),
  );

  const fakeCli: BbCli = {
    run: async (args: string[]) => {
      if (args[0] === "tasks" && args[1] === "preset") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            preset: {
              providerId: "acp-devin",
              permissionMode: "full",
              environmentKind: "host",
              baseBranch: "main",
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "tasks" && args[1] === "show") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            task: { id: "t_scen3", key: "SCEN3-1", title: "Task" },
            project: { id: "proj_scen3", linkedBbProjectId: "proj_scen3_bb" },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };

  // 1) Attempt executor delegate: must be rejected with spec-gate-violation and 0 spawns!
  await assert.rejects(
    async () => {
      await runDelegate(
        {
          taskKey: "SCEN3-1",
          level: "complex",
          caller: {
            threadId: "thr_coord",
            parentThreadId: null,
            title: "coordinator",
            originPluginId: null,
            projectId: "proj_scen3",
          },
        },
        {
          store,
          policy: () => pol.policy,
          loadPolicy: async () => pol,
          bbCli: fakeCli,
          threads: mockThreads as any,
          probes: { roleByThreadId: () => "orchestrator" },
          primaryHostId: async () => "host_1",
          cmd,
          repoRoot: dir,
          workGraphMode: "shadow",
        } as any,
      );
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      assert.match(err.message, /Для старой записи ревью без доказанного базового коммита требуется назначить ревью спецификации с явным диапазоном SHA/);
      return true;
    },
  );
  assert.equal(spawnCount, 0, "No executor must be spawned when baseSha is unproven");

  // 2) Delegate short spec review with explicit range (baseSha, headSha)
  const specRev = await runDelegate(
    {
      taskKey: "SCEN3-1",
      level: "review",
      kind: "spec_review",
      baseSha,
      from: headSha,
      caller: {
        threadId: "thr_coord",
        parentThreadId: null,
        title: "coordinator",
        originPluginId: null,
        projectId: "proj_scen3",
      },
    },
    {
      store,
      policy: () => pol.policy,
      loadPolicy: async () => pol,
      bbCli: fakeCli,
      threads: mockThreads as any,
      probes: { roleByThreadId: () => "orchestrator" },
      primaryHostId: async () => "host_1",
      cmd,
      repoRoot: dir,
      workGraphMode: "shadow",
    } as any,
  );
  assert.equal(specRev.ok, true);

  // Review completes with OK/0
  store.setStatus(specRev.delegationId, "running");
  store.setStatusIf(specRev.delegationId, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  // 3) Now executor delegate succeeds!
  const execRes = await runDelegate(
    {
      taskKey: "SCEN3-1",
      level: "complex",
      caller: {
        threadId: "thr_coord",
        parentThreadId: null,
        title: "coordinator",
        originPluginId: null,
        projectId: "proj_scen3",
      },
    },
    {
      store,
      policy: () => pol.policy,
      loadPolicy: async () => pol,
      bbCli: fakeCli,
      threads: mockThreads as any,
      probes: { roleByThreadId: () => "orchestrator" },
      primaryHostId: async () => "host_1",
      cmd,
      repoRoot: dir,
      workGraphMode: "shadow",
    } as any,
  );
  assert.equal(execRes.status, "running");
  assert.equal(spawnCount, 2, "Executor must be spawned after positive spec review (1 reviewer + 1 executor)");
});

test("§31.9 Acceptance Scenario 2: ordinary review of multi-commit branch with code in commit 1 and doc in commit 2 does NOT approve spec", async () => {
  const dir = makeTempDir("r14-scen2-");
  const { run, cmd } = initGitRepo(dir);

  // Commit 1: add code file
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/feature.ts"), "export const feat = 42;\n");
  run(["add", "."]);
  run(["commit", "-qm", "feat: add feature code"]);
  const codeSha = run(["rev-parse", "HEAD"]).trim();

  // Commit 2: add spec doc (docs-only commit at the tip)
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/scen2.md"), "# Spec\n§1: requirement\n");
  run(["add", "."]);
  run(["commit", "-qm", "docs: add scen2 spec"]);
  const tipSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  store.insertTask({
    taskKey: "SCEN2-1",
    projectId: "proj_scen2",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  });

  let spawnCount = 0;
  const mockThreads = {
    spawn: async () => {
      spawnCount++;
      return { id: "thr_mock_scen2" };
    },
  };

  const pol = parsePolicy(
    JSON.stringify({
      version: 1,
      presets: {
        devin: { provider: "acp-devin", baseBranch: "main" },
        "opus55-review": { provider: "claude-code", baseBranch: "main" },
      },
      routes: {
        devin: { preset: "devin", provider: "acp-devin" },
        "review-opus": { preset: "opus55-review", provider: "claude-code" },
      },
      levels: {
        complex: { chain: ["devin"] },
        review: { chain: ["review-opus"] },
      },
    }),
  );

  const fakeCli: BbCli = {
    run: async (args: string[]) => {
      if (args[0] === "tasks" && args[1] === "preset") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            preset: {
              providerId: "acp-devin",
              permissionMode: "full",
              environmentKind: "host",
              baseBranch: "main",
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "tasks" && args[1] === "show") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            task: { id: "t_scen2", key: "SCEN2-1", title: "Task" },
            project: { id: "proj_scen2", linkedBbProjectId: "proj_scen2_bb" },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };

  // Dispatch ordinary review (NOT spec_review, no baseSha passed)
  const revDel = await runDelegate(
    {
      taskKey: "SCEN2-1",
      level: "review",
      from: tipSha,
      caller: {
        threadId: "thr_coord",
        parentThreadId: null,
        title: "coordinator",
        originPluginId: null,
        projectId: "proj_scen2",
      },
    },
    {
      store,
      policy: () => pol.policy,
      loadPolicy: async () => pol,
      bbCli: fakeCli,
      threads: mockThreads as any,
      probes: { roleByThreadId: () => "orchestrator" },
      primaryHostId: async () => "host_1",
      cmd,
      repoRoot: dir,
      workGraphMode: "shadow",
    } as any,
  );
  assert.equal(revDel.ok, true);

  const revRow = store.get(revDel.delegationId)!;
  const parsedAttach = revRow.attach ? JSON.parse(revRow.attach) : null;
  assert.notEqual(parsedAttach?.kind, "spec_review", "Ordinary review must NOT be marked as spec_review");

  // Review completes OK with 0 blockers
  store.setStatus(revDel.delegationId, "running");
  store.setStatusIf(revDel.delegationId, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  // findAcceptedSpecReview must return null
  const found = await findAcceptedSpecReview({
    taskKey: "SCEN2-1",
    store,
    cmd,
    repoRoot: dir,
    projectId: "proj_scen2",
  });
  assert.equal(found, null, "Ordinary review with code in branch must NOT be accepted as spec review");

  // Attempt to delegate executor: must be rejected with spec-gate-violation and 0 executor spawns!
  await assert.rejects(
    async () => {
      await runDelegate(
        {
          taskKey: "SCEN2-1",
          level: "complex",
          caller: {
            threadId: "thr_coord",
            parentThreadId: null,
            title: "coordinator",
            originPluginId: null,
            projectId: "proj_scen2",
          },
        },
        {
          store,
          policy: () => pol.policy,
          loadPolicy: async () => pol,
          bbCli: fakeCli,
          threads: mockThreads as any,
          probes: { roleByThreadId: () => "orchestrator" },
          primaryHostId: async () => "host_1",
          cmd,
          repoRoot: dir,
          workGraphMode: "shadow",
        } as any,
      );
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
  assert.equal(spawnCount, 1, "Only 1 spawn (the review thread), executor was blocked");
});

test("§31.9 spec review dispatch without confirmed baseSha does not record spec_review approval", async () => {
  const dir = makeTempDir("r14-nobase-");
  const { run, cmd } = initGitRepo(dir);

  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/nobase.md"), "# Spec\n§1: content\n");
  run(["add", "."]);
  run(["commit", "-qm", "docs: nobase spec"]);
  const headSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  store.insertTask({
    taskKey: "NOBASE-1",
    projectId: "proj_nobase",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  });

  const pol = parsePolicy(
    JSON.stringify({
      version: 1,
      presets: {
        devin: { provider: "acp-devin", baseBranch: "main" },
        "opus55-review": { provider: "claude-code", baseBranch: "main" },
      },
      routes: {
        devin: { preset: "devin", provider: "acp-devin" },
        "review-opus": { preset: "opus55-review", provider: "claude-code" },
      },
      levels: {
        complex: { chain: ["devin"] },
        review: { chain: ["review-opus"] },
      },
    }),
  );

  const fakeCli: BbCli = {
    run: async (args: string[]) => {
      if (args[0] === "tasks" && args[1] === "preset") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            preset: {
              providerId: "claude-code",
              permissionMode: "full",
              environmentKind: "host",
              baseBranch: "main",
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "tasks" && args[1] === "show") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            task: { id: "t_nobase", key: "NOBASE-1", title: "Task" },
            project: { id: "proj_nobase", linkedBbProjectId: "proj_nobase_bb" },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };

  // Dispatch spec_review with missing / unconfirmed baseSha
  const revDel = await runDelegate(
    {
      taskKey: "NOBASE-1",
      level: "review",
      kind: "spec_review",
      // baseSha omitted!
      from: headSha,
      caller: {
        threadId: "thr_coord",
        parentThreadId: null,
        title: "coordinator",
        originPluginId: null,
        projectId: "proj_nobase",
      },
    },
    {
      store,
      policy: () => pol.policy,
      loadPolicy: async () => pol,
      bbCli: fakeCli,
      threads: { spawn: async () => ({ id: "thr_mock_nobase" }) } as any,
      probes: { roleByThreadId: () => "orchestrator" },
      primaryHostId: async () => "host_1",
      cmd,
      repoRoot: dir,
      workGraphMode: "shadow",
    } as any,
  );
  assert.equal(revDel.ok, true);

  const revRow = store.get(revDel.delegationId)!;
  const parsedAttach = revRow.attach ? JSON.parse(revRow.attach) : null;
  assert.notEqual(parsedAttach?.kind, "spec_review", "Spec review without confirmed base must NOT record kind: spec_review");
  assert.equal(parsedAttach?.baseSha, undefined);

  // Complete review OK/0
  store.setStatus(revDel.delegationId, "running");
  store.setStatusIf(revDel.delegationId, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  // findAcceptedSpecReview must return null
  const found = await findAcceptedSpecReview({
    taskKey: "NOBASE-1",
    store,
    cmd,
    repoRoot: dir,
    projectId: "proj_nobase",
  });
  assert.equal(found, null);
});

// ── 33. Round 15 & Architect Feedback: Canonical Head & Common-Dir Repo Verification ──

test("§31.9 Scenario A: divergent headSha and from rejects before delegation insert", async () => {
  const dir = makeTempDir("orch-scen-a-");
  const { run, cmd } = initGitRepo(dir);
  const baseSha = run(["rev-parse", "HEAD"]).trim();
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/scen-a.md"), "# Spec A\n§1 Intro\n");
  run(["add", "."]); run(["commit", "-qm", "docs: add spec"]);
  const docSha = run(["rev-parse", "HEAD"]).trim();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/code.ts"), "export const x = 1;\n");
  run(["add", "."]); run(["commit", "-qm", "feat: code change"]);
  const codeSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const pol = parsePolicy(POLICY_TEXT);

  let spawned = false;
  const deps = {
    store,
    policy: () => pol.policy,
    loadPolicy: async () => pol,
    bbCli: fakeCli().cli,
    threads: { spawn: async () => { spawned = true; return { id: "thr_sub" }; } } as any,
    probes: { roleByThreadId: () => "orchestrator" },
    primaryHostId: async () => "host1",
    cmd,
    repoRoot: dir,
    workGraphMode: "shadow",
  } as any;

  // Passing docSha as headSha and codeSha as from (divergent commits) MUST throw spec-head-mismatch
  await assert.rejects(
    async () => {
      await runDelegate(
        {
          taskKey: "SCENA-1",
          level: "review",
          kind: "spec_review",
          baseSha,
          headSha: docSha,
          from: codeSha,
          caller: { threadId: "thr_coord", parentThreadId: null, title: "coord", originPluginId: null, projectId: "proj_bb" },
        } as any,
        deps,
      );
    },
    (err: any) => {
      assert.equal(err.code, "spec-head-mismatch");
      return true;
    },
  );
  assert.equal(spawned, false);
  assert.equal(store.delegationsByTask("SCENA-1").length, 0);
});

test("§31.9 Scenario B: spec review with head-sha but without from records canonical head and enables executor", async () => {
  const dir = makeTempDir("orch-scen-b-");
  const { run, cmd } = initGitRepo(dir);
  const baseSha = run(["rev-parse", "HEAD"]).trim();
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/scen-b.md"), "# Spec B\n§1 Spec details\n");
  run(["add", "."]); run(["commit", "-qm", "docs: add spec"]);
  const docSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.insertTask({
    taskKey: "SCENB-1",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    route: "feature",
    level: "complex",
    confirmationMode: "auto",
  });
  const pol = parsePolicy(POLICY_TEXT);

  let spawns = 0;
  const deps = {
    store,
    policy: () => pol.policy,
    loadPolicy: async () => pol,
    bbCli: fakeCli().cli,
    threads: { spawn: async () => { spawns++; return { id: `thr_sub_${spawns}` }; } } as any,
    probes: { roleByThreadId: () => "orchestrator" },
    primaryHostId: async () => "host1",
    cmd,
    repoRoot: dir,
    workGraphMode: "shadow",
  } as any;

  // Dispatch spec_review with headSha but WITHOUT from on a fresh task
  const delRes = await runDelegate(
    {
      taskKey: "SCENB-1",
      level: "review",
      kind: "spec_review",
      baseSha,
      headSha: docSha,
      caller: { threadId: "thr_coord", parentThreadId: null, title: "coord", originPluginId: null, projectId: "proj_bb" },
    } as any,
    deps,
  );
  assert.equal(delRes.ok, true);

  const row = store.get(delRes.delegationId)!;
  // All three locations MUST match docSha
  assert.equal(row.continue_from, docSha, "row.continue_from must equal docSha");
  const att = JSON.parse(row.attach!);
  assert.equal(att.headSha, docSha, "attach.headSha must equal docSha");
  assert.equal(att.from, docSha, "attach.from must equal docSha");

  // Mark review done with OK/0
  store.setStatus(row.id, "running");
  store.setStatusIf(row.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  // findAcceptedSpecReview MUST find the review
  const found = await findAcceptedSpecReview({
    taskKey: "SCENB-1",
    store,
    cmd,
    repoRoot: dir,
    projectId: "proj_bb",
  });
  assert.ok(found, "Approval must be found");
  assert.equal(found.reviewedSha, docSha);

  // Executor delegation must succeed without spec-gate-violation
  const execDel = await runDelegate(
    {
      taskKey: "SCENB-1",
      level: "complex",
      caller: { threadId: "thr_coord", parentThreadId: null, title: "coord", originPluginId: null, projectId: "proj_bb" },
    } as any,
    deps,
  );
  assert.equal(execDel.ok, true);
});

test("§31.9 Scenario C: canonical git-common-dir allows linked worktrees of same repo and rejects foreign repo with same folder name", async () => {
  // Main repository
  const mainDir = makeTempDir("same-basename-main-");
  const repoA = join(mainDir, "bb-addons");
  mkdirSync(repoA, { recursive: true });
  const { run: runA, cmd: cmdA } = initGitRepo(repoA);
  const baseSha = runA(["rev-parse", "HEAD"]).trim();
  mkdirSync(join(repoA, "docs/specs"), { recursive: true });
  writeFileSync(join(repoA, "docs/specs/c.md"), "# Spec C\n");
  runA(["add", "."]); runA(["commit", "-qm", "docs: add spec"]);
  const headSha = runA(["rev-parse", "HEAD"]).trim();

  // Linked worktree of repoA with different folder name
  const worktreeA = join(mainDir, "bb-addons-worktree-other-name");
  runA(["worktree", "add", worktreeA, "HEAD"]);
  const { cmd: cmdWorktreeA } = initGitRepo(worktreeA);

  // Foreign repo with identical folder name "bb-addons"
  const foreignDir = makeTempDir("same-basename-foreign-");
  const repoForeign = join(foreignDir, "bb-addons");
  mkdirSync(repoForeign, { recursive: true });
  const { cmd: cmdForeign } = initGitRepo(repoForeign);

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const pol = parsePolicy(POLICY_TEXT);

  const depsA = {
    store,
    policy: () => pol.policy,
    loadPolicy: async () => pol,
    bbCli: fakeCli().cli,
    threads: { spawn: async () => ({ id: "thr_sub" }) } as any,
    probes: { roleByThreadId: () => "orchestrator" },
    primaryHostId: async () => "host1",
    cmd: cmdA,
    repoRoot: repoA,
    workGraphMode: "shadow",
  } as any;

  // Review created in repoA
  const rev = await runDelegate(
    {
      taskKey: "SCENC-1",
      level: "review",
      kind: "spec_review",
      baseSha,
      headSha,
      caller: { threadId: "thr_coord", parentThreadId: null, title: "coord", originPluginId: null, projectId: "proj_bb" },
    } as any,
    depsA,
  );
  store.setStatus(rev.delegationId, "running");
  store.setStatusIf(rev.delegationId, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  // 1. Verifying from linked worktree of same repository (different folder name) MUST SUCCEED
  const foundInWorktree = await findAcceptedSpecReview({
    taskKey: "SCENC-1",
    store,
    cmd: cmdWorktreeA,
    repoRoot: worktreeA,
    projectId: "proj_bb",
  });
  assert.ok(foundInWorktree, "Linked worktree of the same repo must be accepted");

  // 2. Verifying from foreign repo with identical folder name MUST REJECT
  const foundInForeign = await findAcceptedSpecReview({
    taskKey: "SCENC-1",
    store,
    cmd: cmdForeign,
    repoRoot: repoForeign,
    projectId: "proj_bb",
  });
  assert.equal(foundInForeign, null, "Foreign repo with same folder name must be rejected");
});

test("§31.9 Finding 3: reviewer instructions include spec range and filter out code files from docs list", async () => {
  const dir = makeTempDir("orch-find3-");
  const { run, cmd } = initGitRepo(dir);
  const baseSha = run(["rev-parse", "HEAD"]).trim();
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/f3.md"), "# Spec F3\n");
  run(["add", "."]); run(["commit", "-qm", "docs: add spec"]);
  const headSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const pol = parsePolicy(POLICY_TEXT);

  // Delegate spec review with attach containing BOTH a doc path and a code path
  let capturedPrompt: string | undefined;
  const del = await runDelegate(
    {
      taskKey: "FIND3-1",
      level: "review",
      kind: "spec_review",
      baseSha,
      headSha,
      attach: ["docs/specs/f3.md", "src/secret-code.ts"],
      caller: { threadId: "thr_coord", parentThreadId: null, title: "coord", originPluginId: null, projectId: "proj_bb" },
    } as any,
    {
      store,
      policy: () => pol.policy,
      loadPolicy: async () => pol,
      bbCli: fakeCli().cli,
      threads: {
        spawn: async (args: any) => {
          capturedPrompt = args.prompt;
          return { id: "thr_auditor" };
        },
      } as any,
      probes: { roleByThreadId: () => "orchestrator" },
      primaryHostId: async () => "host1",
      cmd,
      repoRoot: dir,
      workGraphMode: "shadow",
    } as any,
  );

  const row = store.get(del.delegationId)!;
  const att = JSON.parse(row.attach!);

  // attach.paths preserves code path, while attach.specPaths contains only docs
  assert.ok(att.paths.includes("src/secret-code.ts"), "attach.paths preserves code path");
  assert.ok(att.paths.includes("docs/specs/f3.md"));
  assert.ok(!att.specPaths.includes("src/secret-code.ts"), "attach.specPaths must not include code");
  assert.ok(att.specPaths.includes("docs/specs/f3.md"));

  assert.ok(capturedPrompt, "Prompt must be provided");
  const specRangeLine = capturedPrompt
    .split("\n")
    .find((l) => l.includes("Диапазон проверки спецификации:"));
  assert.ok(specRangeLine, "Spec range line must be present");
  assert.ok(
    specRangeLine.includes(`Диапазон проверки спецификации: ${baseSha}..${headSha}`),
    "Instructions in prompt must contain exact spec range",
  );
  assert.ok(
    specRangeLine.includes("docs/specs/f3.md"),
    "Spec range line must contain spec path",
  );
  assert.ok(
    !specRangeLine.includes("src/secret-code.ts"),
    "Spec range line must NOT list code files under docs",
  );
  // Meanwhile attach line preserves all original paths (§20.1 п.4)
  assert.ok(capturedPrompt.includes("src/secret-code.ts"), "Prompt preserves original attach paths");
});

test("§31.9 Mismatched continue_from vs att.headSha is rejected by findAcceptedSpecReview", async () => {
  const dir = makeTempDir("orch-mismatch-head-");
  const { run, cmd } = initGitRepo(dir);
  const baseSha = run(["rev-parse", "HEAD"]).trim();
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/m.md"), "# Spec\n");
  run(["add", "."]); run(["commit", "-qm", "docs"]);
  const headSha = run(["rev-parse", "HEAD"]).trim();
  const repoId = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  // 1. Mismatched continue_from -> rejected
  const rowMismatch = store.insert({
    taskKey: "MISMATCH-1",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review-route",
    preset: "auditor",
    provider: "acp-devin",
    round: 1,
    continueFrom: "0000000000000000000000000000000000000000", // mismatched continue_from
    explicitRoute: false,
    noCode: true,
    attach: JSON.stringify({
      kind: "spec_review",
      taskKey: "MISMATCH-1",
      projectId: "proj_bb",
      repo: repoId,
      baseSha,
      headSha,
      specPaths: ["docs/specs/m.md"],
      paths: [],
      from: headSha,
    }),
  });
  store.setStatus(rowMismatch.id, "running");
  store.setStatusIf(rowMismatch.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  const foundMismatch = await findAcceptedSpecReview({
    taskKey: "MISMATCH-1",
    store,
    cmd,
    repoRoot: dir,
    projectId: "proj_bb",
  });
  assert.equal(foundMismatch, null, "Mismatched continue_from and att.headSha must be rejected");

  // 2. Matching continue_from with canonical repo -> accepted
  const rowMatch = store.insert({
    taskKey: "MATCH-1",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review-route",
    preset: "auditor",
    provider: "acp-devin",
    round: 1,
    continueFrom: headSha,
    explicitRoute: false,
    noCode: true,
    attach: JSON.stringify({
      kind: "spec_review",
      taskKey: "MATCH-1",
      projectId: "proj_bb",
      repo: repoId,
      baseSha,
      headSha,
      specPaths: ["docs/specs/m.md"],
      paths: [],
      from: headSha,
    }),
  });
  store.setStatus(rowMatch.id, "running");
  store.setStatusIf(rowMatch.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  const foundMatch = await findAcceptedSpecReview({
    taskKey: "MATCH-1",
    store,
    cmd,
    repoRoot: dir,
    projectId: "proj_bb",
  });
  assert.ok(foundMatch, "Matching continue_from and att.headSha must be accepted");
  assert.equal(foundMatch.reviewedSha, headSha);
});

test("§31.9 Code changed and reverted inside base..head range must NOT auto-approve", async () => {
  const dir = makeTempDir("orch-code-revert-");
  const { run, cmd } = initGitRepo(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/code.ts"), "export const x = 1;\n");
  run(["add", "."]); run(["commit", "-qm", "code base"]);
  const baseSha = run(["rev-parse", "HEAD"]).trim();

  // Commit 1: modify code
  writeFileSync(join(dir, "src/code.ts"), "export const x = 2;\n");
  run(["commit", "-qam", "feat: code change"]);

  // Commit 2: revert code back to original
  writeFileSync(join(dir, "src/code.ts"), "export const x = 1;\n");
  run(["commit", "-qam", "revert: revert code change"]);

  // Commit 3: add spec
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/feat.md"), "# Spec\n§1 Intro\n");
  run(["add", "."]); run(["commit", "-qm", "docs: add spec"]);
  const headSha = run(["rev-parse", "HEAD"]).trim();
  const repoId = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();

  // Net diff has ONLY docs/specs/feat.md!
  const netDiff = run(["diff", "--name-only", baseSha, headSha]).trim();
  assert.equal(netDiff, "docs/specs/feat.md");

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  // Even if a record claims kind: "spec_review", findAcceptedSpecReview must reject it
  const row = store.insert({
    taskKey: "REVERT-1",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review-route",
    preset: "auditor",
    provider: "acp-devin",
    round: 1,
    continueFrom: headSha,
    explicitRoute: false,
    noCode: true,
    attach: JSON.stringify({
      kind: "spec_review",
      taskKey: "REVERT-1",
      projectId: "proj_bb",
      repo: repoId,
      baseSha,
      headSha,
      specPaths: ["docs/specs/feat.md"],
      paths: [],
      from: headSha,
    }),
  });
  store.setStatus(row.id, "running");
  store.setStatusIf(row.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  const found = await findAcceptedSpecReview({
    taskKey: "REVERT-1",
    store,
    cmd,
    repoRoot: dir,
    projectId: "proj_bb",
  });
  assert.equal(found, null, "Range with intermediate code commits must NOT auto-approve");
});

test("§31.9 Spec review record without repo identity is strictly rejected", async () => {
  const dir = makeTempDir("orch-no-repo-att-");
  const { run, cmd } = initGitRepo(dir);
  const baseSha = run(["rev-parse", "HEAD"]).trim();
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/norepo.md"), "# No Repo\n");
  run(["add", "."]); run(["commit", "-qm", "docs"]);
  const headSha = run(["rev-parse", "HEAD"]).trim();

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);

  // Record with missing repo field in attach
  const row = store.insert({
    taskKey: "NOREPO-1",
    projectId: "proj_bb",
    coordinatorThreadId: "thr_coord",
    level: "review",
    route: "review-route",
    preset: "auditor",
    provider: "acp-devin",
    round: 1,
    continueFrom: headSha,
    explicitRoute: false,
    noCode: true,
    attach: JSON.stringify({
      kind: "spec_review",
      taskKey: "NOREPO-1",
      projectId: "proj_bb",
      // repo omitted!
      baseSha,
      headSha,
      specPaths: ["docs/specs/norepo.md"],
      paths: [],
      from: headSha,
    }),
  });
  store.setStatus(row.id, "running");
  store.setStatusIf(row.id, "running", "done", {
    reviewVerdict: { verdict: "OK", blockers: 0 },
  } as any);

  const found = await findAcceptedSpecReview({
    taskKey: "NOREPO-1",
    store,
    cmd,
    repoRoot: dir,
    projectId: "proj_bb",
  });
  assert.equal(found, null, "Record without repo identity must be rejected");
});
