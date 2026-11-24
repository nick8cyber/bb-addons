import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp.js";
import { createCmd } from "../src/cmd.js";
import {
  createCoordinatorWorktrees,
  createCoordinatorWorktree,
  environmentShowVerdict,
  type CoordinatorEnvDto,
  type CoordinatorThreadDto,
  type CoordinatorWorktreeSpawnArgs,
} from "../src/coordinator-worktrees.js";
import { OrchestratorError } from "../src/errors.js";
import {
  CoordinatorWorktreeStore,
  DelegationStore,
  MIGRATIONS,
} from "../src/store.js";

const realCmd = createCmd();

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  }).trim();
}

function makeRepo(prefix = "coord-") {
  const base = makeTempDir(prefix);
  const origin = join(base, "origin.git");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, ["config", "user.name", "Agent"]);
  git(repo, ["config", "user.email", "agent@x.io"]);
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "chore: base"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-u", "origin", "main"]);
  return { base, origin, repo };
}

function addEnv(repo: string, base: string, name: string): CoordinatorEnvDto {
  const path = join(base, "envs", name);
  mkdirSync(join(base, "envs"), { recursive: true });
  git(repo, ["worktree", "add", path, "-b", `bb/${name}`]);
  return {
    id: `env_${name}`,
    projectId: "proj_1",
    hostId: "host_1",
    path,
    branchName: `bb/${name}`,
    mergeBaseBranch: "origin/main",
    status: "ready",
    managed: true,
    environmentProviderId: "git-worktree",
    lifecycle: { phase: "active" },
  };
}

function commitIn(path: string, file: string, msg: string) {
  writeFileSync(join(path, file), `${msg}\n`);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", msg]);
}

const archived = (id: string, environmentId: string): CoordinatorThreadDto => ({
  id,
  environmentId,
  archivedAt: Date.now(),
});

function makeWorld(opts: {
  envs?: Map<string, CoordinatorEnvDto | null>;
  envThreads?: Map<string, CoordinatorThreadDto[] | null>;
  roles?: Record<string, string>;
  hasProcessIn?: (p: string) => Promise<boolean | null>;
  /** §7: env ids whose `environment show` transiently fails (throws). */
  envError?: Set<string>;
} = {}) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const roles = new DelegationStore(db);
  for (const [id, role] of Object.entries(opts.roles ?? {})) {
    roles.setThreadRole(id, role, "hook");
  }
  const store = new CoordinatorWorktreeStore(db);
  const clock = { t: Date.now() };
  const wt = createCoordinatorWorktrees({
    store,
    threadRole: (id) => roles.threadRole(id),
    cmd: realCmd,
    showEnvironment: async (id) => {
      if (opts.envError?.has(id)) throw new Error("bb unavailable");
      return opts.envs?.get(id) ?? null;
    },
    delegationIndex: () => roles.delegationTaskIndex(),
    listEnvThreads: async (envId) => opts.envThreads?.get(envId) ?? null,
    hasProcessIn: opts.hasProcessIn ?? (async () => false),
    now: () => clock.t,
    log: {},
  });
  return { roles, store, wt, clock };
}

// ── §7 registration ─────────────────────────────────────────────────

test("register: §7 fields, active/coordinator-live, branch protected", () => {
  const { store } = makeWorld();
  const row = store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: "env_1",
      hostId: "host_1",
      repoRoot: "/repo/.git",
      worktreePath: "/repo/envs/w",
      branch: "bb/coord",
      baseSha: "abc",
    },
    1000,
  );
  assert.equal(row.state, "active");
  assert.equal(row.reason, "coordinator-live");
  assert.equal(row.decision_generation, 1);
  assert.equal(store.liveByThread("thr_c")!.id, row.id);
  assert.ok(store.protectedBranches().has("bb/coord"));
  assert.equal(store.byEnv("env_1")!.id, row.id);
});

test("register: same-env re-register reactivates + bumps generation; rebind closes the old row", () => {
  const { store } = makeWorld();
  const row = store.register(
    {
      projectId: "p",
      coordinatorThreadId: "thr_c",
      envId: "env_1",
      branch: "bb/a",
    },
    1000,
  );
  store.setState(row.id, "archive_pending", null, 1010);
  const again = store.register(
    {
      projectId: "p",
      coordinatorThreadId: "thr_c",
      envId: "env_1",
      branch: "bb/a",
    },
    1020,
  );
  assert.equal(again.id, row.id);
  assert.equal(again.state, "active");
  assert.equal(again.decision_generation, 2);
  const rebound = store.register(
    {
      projectId: "p",
      coordinatorThreadId: "thr_c",
      envId: "env_2",
      branch: "bb/b",
    },
    1030,
  );
  assert.equal(store.byId(row.id)!.state, "removed");
  assert.equal(rebound.state, "active");
  assert.equal(store.liveByThread("thr_c")!.id, rebound.id);
});

test("register: one env — one owner (§7)", () => {
  const { store } = makeWorld();
  store.register(
    {
      projectId: "p",
      coordinatorThreadId: "thr_a",
      envId: "env_1",
    },
    1000,
  );
  assert.throws(
    () =>
      store.register(
        { projectId: "p", coordinatorThreadId: "thr_b", envId: "env_1" },
        1000,
      ),
    /conflict|already bound/,
  );
});

test("ensureBinding: only orchestrator role + provisioned env registers (§13.5)", async () => {
  const { repo, base } = makeRepo("coord-ensure-");
  const env = addEnv(repo, base, "w");
  const envs = new Map([[env.id, env]]);
  // executor-role thread → no binding
  let w = makeWorld({
    envs,
    roles: { thr_exec: "executor" },
  });
  assert.equal(
    await w.wt.ensureBinding({
      id: "thr_exec",
      environmentId: env.id,
      projectId: "proj_1",
    }),
    null,
  );
  // orchestrator-role + ready env → bound with the probed fields
  w = makeWorld({
    envs,
    roles: { thr_c: "orchestrator" },
  });
  const row = await w.wt.ensureBinding({
    id: "thr_c",
    environmentId: env.id,
    projectId: "proj_1",
  });
  assert.ok(row);
  assert.equal(row!.state, "active");
  assert.equal(row!.reason, "coordinator-live");
  assert.equal(row!.env_id, env.id);
  assert.equal(row!.worktree_path, env.path);
  assert.equal(row!.branch, env.branchName);
  assert.equal(row!.base_sha, git(env.path!, ["rev-parse", "origin/main"]));
  // env still provisioning → no binding, retried later
  const wip = makeWorld({
    envs: new Map([[env.id, { ...env, status: "creating" }]]),
    roles: { thr_p: "orchestrator" },
  });
  assert.equal(
    await wip.wt.ensureBinding({
      id: "thr_p",
      environmentId: env.id,
      projectId: "proj_1",
    }),
    null,
  );
});

// ── §16.9 archive admission ─────────────────────────────────────────

test("archive: clean published copy → remove_pending with tip_sha", async () => {
  const { repo, base } = makeRepo("coord-arch-clean-");
  const env = addEnv(repo, base, "w");
  const envThreads = new Map([[env.id!, [archived("thr_c", env.id!)]]]);
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads,
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "remove_pending");
  assert.equal(after.tip_sha, git(env.path!, ["rev-parse", "HEAD"]));
});

test("archive: dirty worktree → held dirty-worktree", async () => {
  const { repo, base } = makeRepo("coord-arch-dirty-");
  const env = addEnv(repo, base, "w");
  writeFileSync(join(env.path!, "unsaved.txt"), "keep me\n");
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "held");
  assert.equal(after.reason, "dirty-worktree");
});

test("archive: unpushed commits → held unpushed-commits", async () => {
  const { repo, base } = makeRepo("coord-arch-unpushed-");
  const env = addEnv(repo, base, "w");
  commitIn(env.path!, "wip.txt", "feat: unpublished");
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "held");
  assert.equal(after.reason, "unpushed-commits");
  assert.equal(after.tip_sha, git(env.path!, ["rev-parse", "HEAD"]));
});

test("archive: a live coordinator-role thread in the env → held coordinator-live", async () => {
  const { repo, base } = makeRepo("coord-arch-live-");
  const env = addEnv(repo, base, "w");
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([
      [
        env.id!,
        [
          archived("thr_c", env.id!),
          { id: "thr_other", environmentId: env.id, archivedAt: null },
        ],
      ],
    ]),
    roles: { thr_c: "orchestrator", thr_other: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "held");
  assert.equal(after.reason, "coordinator-live");
});

test("archive: a live non-coordinator thread defers the decision (archive_pending)", async () => {
  const { repo, base } = makeRepo("coord-arch-pend-");
  const env = addEnv(repo, base, "w");
  const envThreads = new Map<string, CoordinatorThreadDto[] | null>([
    [
      env.id!,
      [
        archived("thr_c", env.id!),
        { id: "thr_exec", environmentId: env.id, archivedAt: null },
      ],
    ],
  ]);
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads,
    roles: { thr_c: "orchestrator", thr_exec: "executor" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  assert.equal(w.store.byId(row.id)!.state, "archive_pending");
  // The sharing thread leaving unblocks the admission — re-evaluated
  // via its own archive event on the same env.
  envThreads.set(env.id!, [
    archived("thr_c", env.id!),
    archived("thr_exec", env.id!),
  ]);
  await w.wt.onThreadArchived(archived("thr_exec", env.id!));
  assert.equal(w.store.byId(row.id)!.state, "remove_pending");
});

test("archive: active process → held active-processes", async () => {
  const { repo, base } = makeRepo("coord-arch-proc-");
  const env = addEnv(repo, base, "w");
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
    hasProcessIn: async () => true,
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "held");
  assert.equal(after.reason, "active-processes");
});

test("archive: env gone → env-removed", async () => {
  const w = makeWorld({
    envs: new Map(),
    envThreads: new Map([["env_gone", [archived("thr_c", "env_gone")]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: "env_gone",
      worktreePath: "/definitely/missing",
      branch: "bb/gone",
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", "env_gone"));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "env-removed");
  // The branch record survives — still protected until `removed`.
  assert.ok(w.store.protectedBranches().has("bb/gone"));
});

test("archive: fetch failure → held remote-unavailable", async () => {
  const { repo, base } = makeRepo("coord-arch-remote-");
  const env = addEnv(repo, base, "w");
  git(repo, ["remote", "remove", "origin"]);
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "held");
  assert.equal(after.reason, "remote-unavailable");
});

test("unarchive cancels the admission: active + new generation, stale verdict discarded", async () => {
  const { repo, base } = makeRepo("coord-unarch-");
  const env = addEnv(repo, base, "w");
  commitIn(env.path!, "wip.txt", "feat: unpublished");
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const held = w.store.byId(row.id)!;
  assert.equal(held.state, "held");
  assert.equal(held.reason, "unpushed-commits");
  const heldGen = held.decision_generation;
  // §16.9 п.4: unarchive before removal cancels the cleanup decision.
  await w.wt.onThreadUnarchived({
    id: "thr_c",
    environmentId: env.id,
    archivedAt: null,
  });
  const live = w.store.byId(row.id)!;
  assert.equal(live.state, "active");
  assert.equal(live.reason, "coordinator-live");
  assert.ok(live.decision_generation > heldGen);
  // A verdict written for the superseded generation cannot land.
  assert.equal(
    w.store.decide(row.id, heldGen, "remove_pending", null, w.clock.t),
    false,
  );
  assert.equal(w.store.byId(row.id)!.state, "active");
});

// ── r6 audit fixes (PLUG-392) ──────────────────────────────────────

/** Insert a delegation row; `threadId`/`status`/`envId` refine it. */
function addDelegation(
  w: { roles: DelegationStore },
  opts: {
    threadId?: string;
    status?: "dispatching" | "running" | "done" | "failed";
    envId?: string;
  } = {},
) {
  const d = w.roles.insert({
    taskKey: "PLUG-392",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "p",
  });
  if (opts.threadId) w.roles.setThreadInfo(d.id, opts.threadId);
  if (opts.status) w.roles.setStatus(d.id, opts.status);
  if (opts.envId) {
    w.roles.setRoundResult(d.id, {
      envId: opts.envId,
      branch: "bb/x",
      sha: "a".repeat(40),
      commits: 1,
      dirty: false,
    });
  }
  return d;
}

test("ensureBinding: a delegation result env is refused — coordinator-worktree-required", async () => {
  const { repo, base } = makeRepo("coord-ensure-deleg-");
  const env = addEnv(repo, base, "w");
  const w = makeWorld({
    envs: new Map([[env.id, env]]),
    roles: { thr_c: "orchestrator" },
  });
  addDelegation(w, {
    threadId: "thr_exec",
    status: "done",
    envId: env.id!,
  });
  assert.equal(
    await w.wt.ensureBinding({
      id: "thr_c",
      environmentId: env.id,
      projectId: "proj_1",
    }),
    null,
  );
  assert.equal(w.store.byThread("thr_c"), undefined);
});

// ── r7 audit fixes (PLUG-392) ──────────────────────────────────────

test("environmentShowVerdict: only the structured BB answer is «gone» (§7, audit В2)", () => {
  assert.equal(
    environmentShowVerdict({ exitCode: 0, stdout: "{}", stderr: "" }),
    "ok",
  );
  // The real BB answer for a removed env: exit 1 + JSON error.code.
  assert.equal(
    environmentShowVerdict({
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: "environment_not_found" },
      }),
      stderr: "",
    }),
    "gone",
  );
  // «bb CLI not found» (exit 127, bb-cli.ts) must never read as
  // «env removed» — and neither must loose «not found» text.
  assert.equal(
    environmentShowVerdict({
      exitCode: 127,
      stdout: "",
      stderr: "bb CLI not found: bb",
    }),
    "failed",
  );
  assert.equal(
    environmentShowVerdict({
      exitCode: 1,
      stdout: "environment not found",
      stderr: "",
    }),
    "failed",
  );
  assert.equal(
    environmentShowVerdict({
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: "permission_denied" },
      }),
      stderr: "",
    }),
    "failed",
  );
  assert.equal(
    environmentShowVerdict({
      exitCode: 2,
      stdout: JSON.stringify({
        ok: false,
        error: { code: "environment_not_found" },
      }),
      stderr: "",
    }),
    "failed",
  );
});

test("ensureBinding: an executor promoted mid-round is refused — result_env_id is still NULL (§13.5 п.2, audit Б3)", async () => {
  const { repo, base } = makeRepo("coord-live-round-");
  const env = addEnv(repo, base, "w");
  const w = makeWorld({
    envs: new Map([[env.id, env]]),
    roles: { thr_exec: "orchestrator" },
  });
  // The round is running: result_env_id lands only at round end, so
  // the executor's own thread id is the marker.
  addDelegation(w, { threadId: "thr_exec", status: "running" });
  assert.equal(
    await w.wt.ensureBinding({
      id: "thr_exec",
      environmentId: env.id,
      projectId: "proj_1",
    }),
    null,
  );
  assert.equal(w.store.byThread("thr_exec"), undefined);
});

test("ensureBinding: an env shared with a live delegation thread is refused (§13.5 п.2, audit Б3)", async () => {
  const { repo, base } = makeRepo("coord-live-env-");
  const env = addEnv(repo, base, "w");
  const w = makeWorld({
    envs: new Map([[env.id, env]]),
    roles: { thr_c: "orchestrator" },
    envThreads: new Map([
      [env.id!, [{ id: "thr_exec", environmentId: env.id }]],
    ]),
  });
  // A different thread's live round occupies the env — refused too.
  addDelegation(w, { threadId: "thr_exec", status: "running" });
  assert.equal(
    await w.wt.ensureBinding({
      id: "thr_c",
      environmentId: env.id,
      projectId: "proj_1",
    }),
    null,
  );
  assert.equal(w.store.byThread("thr_c"), undefined);
});

test("ensureBinding: a done round does not refuse a dedicated env (§13.5 п.2)", async () => {
  const { repo, base } = makeRepo("coord-new-env-");
  const env = addEnv(repo, base, "w");
  const w = makeWorld({
    envs: new Map([[env.id, env]]),
    roles: { thr_exec: "orchestrator" },
    envThreads: new Map([[env.id!, []]]),
  });
  // The past round recorded env_old; the thread now sits in a fresh
  // dedicated worktree — registration must go through.
  addDelegation(w, {
    threadId: "thr_exec",
    status: "done",
    envId: "env_old",
  });
  assert.ok(
    await w.wt.ensureBinding({
      id: "thr_exec",
      environmentId: env.id,
      projectId: "proj_1",
    }),
  );
});

test("ensureBinding: an unpublished base is refused — base-unpublished (§13.5 п.2)", async () => {
  const { repo, base } = makeRepo("coord-ensure-base-");
  // The env is created from a commit origin has never seen.
  commitIn(repo, "local.txt", "feat: local-only base");
  const env = addEnv(repo, base, "w2");
  const w = makeWorld({
    envs: new Map([[env.id, env]]),
    roles: { thr_c: "orchestrator" },
  });
  assert.equal(
    await w.wt.ensureBinding({
      id: "thr_c",
      environmentId: env.id,
      projectId: "proj_1",
    }),
    null,
  );
  assert.equal(w.store.byThread("thr_c"), undefined);
  // …while a copy created from the published tip registers (the
  // «Created from» reflog base passes `log origin/main..<base>`).
  const { repo: repo2, base: base2 } = makeRepo("coord-ensure-pub-");
  const env2 = addEnv(repo2, base2, "w");
  const w3 = makeWorld({
    envs: new Map([[env2.id, env2]]),
    roles: { thr_c: "orchestrator" },
  });
  assert.ok(
    await w3.wt.ensureBinding({
      id: "thr_c",
      environmentId: env2.id,
      projectId: "proj_1",
    }),
  );
});

test("ensureBinding: a transient environment show failure → null, no binding (§7)", async () => {
  const { repo, base } = makeRepo("coord-ensure-err-");
  const env = addEnv(repo, base, "w");
  const w = makeWorld({
    envs: new Map([[env.id, env]]),
    roles: { thr_c: "orchestrator" },
    envError: new Set([env.id!]),
  });
  assert.equal(
    await w.wt.ensureBinding({
      id: "thr_c",
      environmentId: env.id,
      projectId: "proj_1",
    }),
    null,
  );
  assert.equal(w.store.byThread("thr_c"), undefined);
});

test("archive: a reset-orphaned commit (reflog-only) → held unpushed-commits", async () => {
  const { repo, base } = makeRepo("coord-arch-reset-");
  const env = addEnv(repo, base, "w");
  commitIn(env.path!, "wip.txt", "feat: orphaned by reset");
  // The commit survives only in the reflogs — the tree is clean and
  // the tip sits back on origin.
  git(env.path!, ["reset", "--hard", "origin/main"]);
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "held");
  assert.equal(after.reason, "unpushed-commits");
});

test("archive: a detached-HEAD commit → held unpushed-commits", async () => {
  const { repo, base } = makeRepo("coord-arch-detach-");
  const env = addEnv(repo, base, "w");
  git(env.path!, ["checkout", "--detach", "HEAD"]);
  commitIn(env.path!, "det.txt", "feat: detached work");
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "held");
  assert.equal(after.reason, "unpushed-commits");
});

test("archive: a nested node_modules is expendable → remove_pending", async () => {
  const { repo, base } = makeRepo("coord-arch-nm-");
  const env = addEnv(repo, base, "w");
  // Repo-local ignore rules — .git/info/exclude never dirties status.
  const commonDir = git(env.path!, ["rev-parse", "--git-common-dir"]);
  writeFileSync(join(commonDir, "info", "exclude"), "node_modules/\n");
  mkdirSync(join(env.path!, "plugins", "x", "node_modules"), {
    recursive: true,
  });
  writeFileSync(
    join(env.path!, "plugins", "x", "node_modules", "pkg.js"),
    "x\n",
  );
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "remove_pending");
});

test("archive: a non-expendable ignored path → held untracked-ignored", async () => {
  const { repo, base } = makeRepo("coord-arch-ign-");
  const env = addEnv(repo, base, "w");
  const commonDir = git(env.path!, ["rev-parse", "--git-common-dir"]);
  writeFileSync(join(commonDir, "info", "exclude"), "secret/\n");
  mkdirSync(join(env.path!, "secret"));
  writeFileSync(join(env.path!, "secret", "key.txt"), "k\n");
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  const after = w.store.byId(row.id)!;
  assert.equal(after.state, "held");
  assert.equal(after.reason, "untracked-ignored");
});

test("unarchive: env-removed is not revived — a new copy is required (§16.9 п.3)", async () => {
  const w = makeWorld({
    envs: new Map(),
    envThreads: new Map([["env_gone", [archived("thr_c", "env_gone")]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: "env_gone",
      worktreePath: "/definitely/missing",
      branch: "bb/gone",
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", "env_gone"));
  assert.equal(w.store.byId(row.id)!.state, "env-removed");
  await w.wt.onThreadUnarchived({
    id: "thr_c",
    environmentId: "env_gone",
    archivedAt: null,
  });
  assert.equal(w.store.byId(row.id)!.state, "env-removed");
});

test("unarchive of remove_pending re-checks the env: gone → env-removed, live → active, error → held", async () => {
  const { repo, base } = makeRepo("coord-unarch-rp-");
  const env = addEnv(repo, base, "w");
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  assert.equal(w.store.byId(row.id)!.state, "remove_pending");
  // The env is still there → the admission is cancelled.
  await w.wt.onThreadUnarchived({
    id: "thr_c",
    environmentId: env.id,
    archivedAt: null,
  });
  assert.equal(w.store.byId(row.id)!.state, "active");
  // Back to remove_pending, then BB retires the env → env-removed.
  await w.wt.onThreadArchived(archived("thr_c", env.id!));
  assert.equal(w.store.byId(row.id)!.state, "remove_pending");
  const w2 = makeWorld({
    envs: new Map(),
    roles: { thr_c: "orchestrator" },
  });
  const row2 = w2.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: "env_retired",
      worktreePath: "/definitely/missing",
      branch: "bb/gone",
    },
    w2.clock.t,
  );
  w2.store.setState(row2.id, "remove_pending", null, w2.clock.t);
  await w2.wt.onThreadUnarchived({
    id: "thr_c",
    environmentId: "env_retired",
    archivedAt: null,
  });
  assert.equal(w2.store.byId(row2.id)!.state, "env-removed");
  // A transient lookup failure keeps the property — never env-removed.
  const w3 = makeWorld({
    envs: new Map([[env.id!, env]]),
    roles: { thr_c: "orchestrator" },
    envError: new Set([env.id!]),
  });
  const row3 = w3.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w3.clock.t,
  );
  w3.store.setState(row3.id, "remove_pending", null, w3.clock.t);
  await w3.wt.onThreadUnarchived({
    id: "thr_c",
    environmentId: env.id,
    archivedAt: null,
  });
  assert.equal(w3.store.byId(row3.id)!.state, "held");
  assert.equal(w3.store.byId(row3.id)!.reason, "remote-unavailable");
});

test("archive: a transient environment show failure → archive_pending, never env-removed (§7)", async () => {
  const { repo, base } = makeRepo("coord-arch-err-");
  const env = addEnv(repo, base, "w");
  const w = makeWorld({
    envs: new Map([[env.id!, env]]),
    envThreads: new Map([[env.id!, [archived("thr_c", env.id!)]]]),
    roles: { thr_c: "orchestrator" },
    envError: new Set([env.id!]),
  });
  const row = w.store.register(
    {
      projectId: "proj_1",
      coordinatorThreadId: "thr_c",
      envId: env.id!,
      worktreePath: env.path,
      branch: env.branchName,
    },
    w.clock.t,
  );
});

// ── §13.5 п.1 (PLUG-406): `worktree create` ───────────────────────

test("worktree create: refuses bad args before spawning", async () => {
  const w = makeWorld();
  await assert.rejects(
    createCoordinatorWorktree({
      projectId: "proj_1",
      baseSha: "",
      spawn: async () => ({ id: "thr_new", environmentId: "env_new" }),
      showEnvironment: async () => null,
      register: async (bind, opts) => w.store.register(bind, w.clock.t),
    }),
    (e: unknown) =>
      e instanceof OrchestratorError && e.code === "invalid-arguments",
  );
});

test("worktree create: spawn without a thread/env is refused", async () => {
  const w = makeWorld();
  await assert.rejects(
    createCoordinatorWorktree({
      projectId: "proj_1",
      baseSha: "a".repeat(40),
      spawn: async () => ({}),
      showEnvironment: async () => null,
      register: async (bind, opts) => w.store.register(bind, w.clock.t),
    }),
    (e: unknown) =>
      e instanceof OrchestratorError && e.code === "spawn-failed",
  );
});

test("worktree create: waits for the provisioning, spawns the coordinator on the fresh base and registers the binding as active", async () => {
  const { repo, base } = makeRepo("coord-create-");
  const env = addEnv(repo, base, "w");
  const baseSha = git(env.path!, ["rev-parse", "origin/main"]);
  const world = makeWorld({
    envs: new Map([[env.id, env]]),
  });
  const envs = new Map<string, CoordinatorEnvDto | null>([
    [env.id, { ...env, status: "creating" }],
  ]);
  const spawnedArgs: CoordinatorWorktreeSpawnArgs[] = [];
  // provisioning finished → the same env answers ready on the next poll.
  envs.set(env.id, env);
  const created = await createCoordinatorWorktree({
    projectId: "proj_1",
    baseSha,
    spawn: async (args) => {
      spawnedArgs.push(args);
      return { id: "thr_new", environmentId: env.id };
    },
    showEnvironment: async (id) => envs.get(id) ?? null,
    register: async (bind, opts) => world.store.register(bind, world.clock.t),
    cmd: realCmd,
    hostId: "host_1",
    prompt: "coordinator seed",
    pollIntervalMs: 5,
  });
  assert.deepEqual(created, {
    threadId: "thr_new",
    envId: env.id!,
    branch: env.branchName,
    worktreePath: env.path,
    baseSha,
  });
  assert.equal(spawnedArgs.length, 1);
  assert.equal(spawnedArgs[0]!.projectId, "proj_1");
  assert.equal(spawnedArgs[0]!.title, "coordinator");
  assert.equal(spawnedArgs[0]!.prompt, "coordinator seed");
  assert.equal(spawnedArgs[0]!.environment.type, "host");
  assert.equal(spawnedArgs[0]!.environment.hostId, "host_1");
  assert.equal(spawnedArgs[0]!.environment.workspace.type, "managed-worktree");
  assert.deepEqual(spawnedArgs[0]!.environment.workspace.baseBranch, {
    kind: "named",
    name: baseSha,
  });
});

test("worktree create: a ready env registers the binding in state active", async () => {
  const { repo, base } = makeRepo("coord-create-ready-");
  const env = addEnv(repo, base, "w");
  const world = makeWorld({
    envs: new Map([[env.id, env]]),
  });
  const envs = new Map<string, CoordinatorEnvDto | null>([
    [env.id, env],
  ]);
  const created = await createCoordinatorWorktree({
    projectId: "proj_1",
    baseSha: git(env.path!, ["rev-parse", "origin/main"]),
    spawn: async () => ({ id: "thr_new", environmentId: env.id }),
    showEnvironment: async (id) => envs.get(id) ?? null,
    register: async (bind, opts) => world.store.register(bind, world.clock.t),
    cmd: realCmd,
  });
  assert.equal(created.threadId, "thr_new");
  const row = world.store.byThread("thr_new");
  assert.ok(row);
  assert.equal(row!.state, "active");
  assert.equal(row!.reason, "coordinator-live");
  assert.equal(row!.env_id, env.id);
  assert.equal(row!.worktree_path, env.path);
  assert.equal(row!.branch, env.branchName);
  assert.equal(row!.base_sha, created.baseSha);
});

test("worktree create: waits through pending provisioning until the env becomes ready", async () => {
  const { repo, base } = makeRepo("coord-create-wait-");
  const env = addEnv(repo, base, "w");
  const world = makeWorld({
    envs: new Map([[env.id, env]]),
  });
  let polls = 0;
  let status: string = "creating";
  const created = await createCoordinatorWorktree({
    projectId: "proj_1",
    baseSha: git(env.path!, ["rev-parse", "origin/main"]),
    spawn: async () => ({ id: "thr_new", environmentId: env.id }),
    showEnvironment: async () => {
      polls += 1;
      // provisioning finished between two polls → the next answer is ready
      if (polls === 2) status = "ready";
      return { ...env, status };
    },
    register: async (bind, opts) => world.store.register(bind, world.clock.t),
    cmd: realCmd,
    hostId: "host_1",
    prompt: "coordinator seed",
    pollIntervalMs: 5,
    timeoutMs: 5_000,
  });
  assert.equal(created.threadId, "thr_new");
  assert.equal(polls, 2);
});

test("worktree create: a gone env refuses with env-gone carrying thread+env ids", async () => {
  const { repo, base } = makeRepo("coord-create-gone-");
  const env = addEnv(repo, base, "w");
  const envs = new Map<string, CoordinatorEnvDto | null>([
    [env.id!, { ...env, status: "destroyed" }],
  ]);
  const world = makeWorld({ envs });
  await assert.rejects(
    createCoordinatorWorktree({
      projectId: "proj_1",
      baseSha: "a".repeat(40),
      spawn: async () => ({ id: "thr_new", environmentId: env.id! }),
      showEnvironment: async (id) => envs.get(id) ?? null,
      register: async (bind, opts) => world.store.register(bind, world.clock.t),
      cmd: realCmd,
      timeoutMs: 150,
      pollIntervalMs: 5,
    }),
    (e: unknown) =>
      e instanceof OrchestratorError &&
      e.code === "env-gone" &&
      String(e.details?.threadId) === "thr_new" &&
      String(e.details?.envId) === env.id,
  );
});

test("worktree create: retries a transient environment show failure until ready", async () => {
  const { repo, base } = makeRepo("coord-create-trans-");
  const env = addEnv(repo, base, "w");
  const world = makeWorld({
    envs: new Map([[env.id, env]]),
  });
  const shown: string[] = [];
  const created = await createCoordinatorWorktree({
    projectId: "proj_1",
    baseSha: git(env.path!, ["rev-parse", "origin/main"]),
    spawn: async () => ({ id: "thr_new", environmentId: env.id }),
    showEnvironment: async (id) => {
      shown.push(id);
      // §7: a transient bb failure keeps the property — the poll retries.
      if (shown.length === 1) throw new Error("bb CLI not found");
      return env;
    },
    register: async (bind, opts) => world.store.register(bind, world.clock.t),
    cmd: realCmd,
    hostId: "host_1",
    prompt: "coordinator seed",
    pollIntervalMs: 5,
  });
  assert.equal(created.threadId, "thr_new");
  assert.equal(shown.length, 2);
});

test("worktree create: registers the binding against the caller's --target branch", async () => {
  const { repo, base } = makeRepo("coord-create-target-");
  const env = addEnv(repo, base, "w");
  const world = makeWorld({
    envs: new Map([[env.id, env]]),
  });
  let registeredOpts: { targetBranch?: string } | undefined;
  const created = await createCoordinatorWorktree({
    projectId: "proj_1",
    baseSha: git(env.path!, ["rev-parse", "origin/main"]),
    targetBranch: "dev",
    spawn: async () => ({ id: "thr_new", environmentId: env.id }),
    showEnvironment: async () => env,
    register: async (bind, opts) => {
      registeredOpts = opts;
      return world.store.register(bind, world.clock.t);
    },
    cmd: realCmd,
    hostId: "host_1",
    prompt: "coordinator seed",
    pollIntervalMs: 5,
  });
  assert.equal(created.threadId, "thr_new");
  assert.equal(registeredOpts?.targetBranch, "dev");
});

test("worktree create: an env that never becomes ready refuses with provisioning-timeout", async () => {
  const { repo, base } = makeRepo("coord-create-wip-");
  const env = addEnv(repo, base, "w");
  const envs = new Map<string, CoordinatorEnvDto | null>([
    [env.id!, { ...env, status: "creating" }],
  ]);
  const world = makeWorld({ envs });
  await assert.rejects(
    createCoordinatorWorktree({
      projectId: "proj_1",
      baseSha: "a".repeat(40),
      spawn: async () => ({ id: "thr_new", environmentId: env.id! }),
      showEnvironment: async (id) => envs.get(id) ?? null,
      register: async (bind, opts) => world.store.register(bind, world.clock.t),
      cmd: realCmd,
      timeoutMs: 150,
      pollIntervalMs: 5,
    }),
    (e: unknown) =>
      e instanceof OrchestratorError &&
      e.code === "provisioning-timeout" &&
      String(e.details?.threadId) === "thr_new" &&
      String(e.details?.envId) === env.id,
  );
});
