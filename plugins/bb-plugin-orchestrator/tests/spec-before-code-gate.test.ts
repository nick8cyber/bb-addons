// plugins/bb-plugin-orchestrator/tests/spec-before-code-gate.test.ts
// Acceptance tests for spec-before-code gate (§31.9, orchestrator-release §2, ADR-0032)

import assert from "node:assert/strict";
import test from "node:test";

const ORIGINAL_BB_THREAD_ID = process.env.BB_THREAD_ID;
delete process.env.BB_THREAD_ID;
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

  const contract: SpecContract = {
    kind: "bugfix",
    specPath: "docs/specs/graph.md",
    specSection: "§31.9",
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
      await runRunQueue({
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
        policy: parsePolicy(POLICY_TEXT).policy,
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
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
      await runRunQueue({
        store,
        cmd,
        repoRoot: repoDir,
        workGraphMode: "shadow",
        policy: parsePolicy(POLICY_TEXT).policy,
      });
    },
    (err: any) => {
      assert.equal(err.code, "spec-gate-violation");
      return true;
    },
  );
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

  // Now owner rejects the task
  await runReject("NEG-1", "code", "architecture needs revision", {
    store,
    ctx: fakeCtx,
    workGraphMode: "shadow",
  });

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
