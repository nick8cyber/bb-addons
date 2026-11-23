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
  type CoordinatorEnvDto,
  type CoordinatorThreadDto,
} from "../src/coordinator-worktrees.js";
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
    showEnvironment: async (id) => opts.envs?.get(id) ?? null,
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
