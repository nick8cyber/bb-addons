import assert from "node:assert/strict";
import test from "node:test";
import {
  wrapPromptWithPacket,
  resolveRef,
  resolveRepoPath,
  PacketSkip,
  type PacketGit,
} from "../src/packet.js";
import { OrchestratorError } from "../src/errors.js";
import type { DelegationRow } from "../src/store.js";

function makeRow(overrides: Partial<DelegationRow> = {}): DelegationRow {
  return {
    id: 1,
    task_key: "PLUG-100",
    task_id: "task_100",
    project_id: "proj_main",
    coordinator_thread_id: "thr_coord",
    thread_id: null,
    level: "review",
    route: "argon",
    preset: "argon-preset",
    provider: "acp-argon",
    status: "dispatching",
    reissue_of: null,
    turn_started_at: null,
    first_response_at: null,
    last_seq: null,
    setup_errors: "[]",
    last_approval_notified_at: null,
    timeout_notified_at: null,
    resume_count: 0,
    retry_count: 0,
    round: 1,
    continue_from: null,
    result_branch: null,
    result_sha: null,
    result_commits: null,
    result_dirty: null,
    result_env_id: null,
    merge_status: null,
    merged_into: null,
    merged_sha: null,
    merged_at: null,
    explicit_route: 0,
    result_notified_at: null,
    result_notice: null,
    revived_count: 0,
    last_response_at: null,
    no_code: 0,
    verdict_nudged_at: null,
    verdict_nudge_seq: null,
    verdict_event_at: null,
    queued_at: null,
    attach: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ДЕФЕКТ 1: resolveRepoPath
// ─────────────────────────────────────────────────────────────────────────────

test("PLUG-295: fresh review row without result_env_id takes env of task's last done result", async () => {
  const row = makeRow({ result_env_id: null });
  const doneResult = makeRow({
    id: 5,
    result_env_id: "env_exec_worktree",
    result_sha: "shaEXEC",
    status: "done",
  });
  let coordThreadQueried = false;
  const path = await resolveRepoPath(row, {
    store: {
      latestDoneResultByTask: (taskKey) => {
        assert.equal(taskKey, "PLUG-100");
        return doneResult;
      },
    },
    threads: {
      get: async () => {
        coordThreadQueried = true;
        return { environmentId: "env_coord" };
      },
    },
    environmentFacts: async (envId) => {
      if (envId === "env_exec_worktree") {
        return { id: "env_exec_worktree", path: "/worktrees/exec-1" };
      }
      return {};
    },
  });
  assert.equal(path, "/worktrees/exec-1");
  assert.equal(coordThreadQueried, false, "coordinator thread should not be queried when task done result env is alive");
});

test("PLUG-295: resolveRepoPath falls back to next candidate when preferred env is dead", async () => {
  const row = makeRow({ result_env_id: "env_dead_1" });
  const doneResult = makeRow({
    id: 5,
    result_env_id: "env_dead_2",
    result_sha: "shaEXEC",
    status: "done",
  });
  const path = await resolveRepoPath(row, {
    store: {
      latestDoneResultByTask: () => doneResult,
    },
    threads: {
      get: async ({ threadId }) => {
        assert.equal(threadId, "thr_coord");
        return { environmentId: "env_coord_alive" };
      },
    },
    environmentFacts: async (envId) => {
      if (envId === "env_dead_1") throw new Error("env not found: env_dead_1");
      if (envId === "env_dead_2") return { id: "env_dead_2", path: undefined };
      if (envId === "env_coord_alive") return { id: "env_coord_alive", path: "/work/main-repo" };
      return {};
    },
  });
  assert.equal(path, "/work/main-repo");
});

test("PLUG-295: resolveRepoPath returns null when all env candidates are dead or missing", async () => {
  const row = makeRow({ result_env_id: "env_dead" });
  const path = await resolveRepoPath(row, {
    store: {
      latestDoneResultByTask: () => undefined,
    },
    threads: {
      get: async () => ({ environmentId: null }),
    },
    environmentFacts: async () => {
      throw new Error("404");
    },
  });
  assert.equal(path, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// ДЕФЕКТ 2: target != link, local default branches, non-empty diff in worktree
// ─────────────────────────────────────────────────────────────────────────────

test("PLUG-295: resolveRef skips candidate equal to link and continues to next candidate", async () => {
  const git: PacketGit = async (_repo, args) => {
    const line = args.join(" ");
    if (line.includes("origin/HEAD")) return "shaLINK\n";
    if (line.includes("main")) return "shaMAIN\n";
    if (line.includes("HEAD")) return "shaLINK\n";
    throw new Error(`unknown ref: ${line}`);
  };
  const skip = (sha: string) => sha === "shaLINK";
  const target = await resolveRef(git, "/repo", ["origin/HEAD", "main", "HEAD"], skip);
  assert.equal(target, "shaMAIN");
});

test("PLUG-295: worktree with HEAD=result-sha and local main produces non-empty diff (not packet-empty)", async () => {
  const resultSha = "1111111111111111111111111111111111111111";
  const mainSha = "2222222222222222222222222222222222222222";
  const git: PacketGit = async (_repo, args) => {
    const cmd = args[0];
    if (cmd === "rev-parse") {
      const ref = args[2] ?? "";
      if (ref.includes(resultSha)) return `${resultSha}\n`;
      if (ref.startsWith("origin/")) throw new Error("no such remote ref");
      if (ref.startsWith("main")) return `${mainSha}\n`;
      if (ref.startsWith("master")) throw new Error("no master");
      if (ref.startsWith("HEAD")) return `${resultSha}\n`;
      throw new Error(`unknown ref ${ref}`);
    }
    if (cmd === "merge-base") {
      const target = args[1];
      const link = args[2];
      assert.equal(target, mainSha, "target should be mainSha, not resultSha");
      assert.equal(link, resultSha);
      return `${mainSha}\n`;
    }
    if (cmd === "diff") {
      if (args.includes("--stat")) {
        return " src/feature.ts | 5 +++++\n 1 file changed, 5 insertions(+)\n";
      }
      return "diff --git a/src/feature.ts b/src/feature.ts\nnew file mode 100644\n+console.log('hi');\n";
    }
    return "";
  };

  const res = await wrapPromptWithPacket({
    role: "auditor",
    prompt: "Проверь реализацию задачи",
    spec: { paths: [], from: null },
    continueFrom: resultSha,
    repoPath: "/worktrees/exec-1",
    git,
  });

  assert.match(res.prompt, /МАТЕРИАЛ ДЛЯ ПРОВЕРКИ/);
  assert.ok(res.prompt.includes("src/feature.ts | 5 +++++"));
  assert.ok(res.prompt.includes("+console.log('hi');"));
});

test("PLUG-295: when target would equal link and no other candidate resolves, throws packet-repo", async () => {
  const linkSha = "1111111111111111111111111111111111111111";
  const git: PacketGit = async (_repo, args) => {
    if (args[0] === "rev-parse") {
      return `${linkSha}\n`;
    }
    return "";
  };

  await assert.rejects(
    () =>
      wrapPromptWithPacket({
        role: "auditor",
        prompt: "Проверь",
        spec: { paths: [], from: linkSha },
        continueFrom: null,
        repoPath: "/worktree",
        git,
      }),
    (err: OrchestratorError) => {
      assert.equal(err.code, "packet-repo");
      assert.match(err.message, /no target ref resolved/);
      return true;
    },
  );
});

test("PLUG-295: merge-base(target,link)==link when target!=link is allowed (link is ancestor)", async () => {
  const linkSha = "1111111111111111111111111111111111111111";
  const targetSha = "2222222222222222222222222222222222222222";
  const git: PacketGit = async (_repo, args) => {
    if (args[0] === "rev-parse") {
      const ref = args[2] ?? "";
      if (ref.includes(linkSha)) return `${linkSha}\n`;
      if (ref.startsWith("origin/")) throw new Error("no origin");
      if (ref.startsWith("main")) return `${targetSha}\n`;
      return `${targetSha}\n`;
    }
    if (args[0] === "merge-base") {
      // link is ancestor of target -> merge-base returns linkSha
      return `${linkSha}\n`;
    }
    if (args[0] === "diff") {
      if (args.includes("--stat")) return " file.txt | 1 +\n";
      return "diff --git a/file.txt b/file.txt\n+change\n";
    }
    return "";
  };

  const res = await wrapPromptWithPacket({
    role: "auditor",
    prompt: "Проверь",
    spec: { paths: [], from: linkSha },
    continueFrom: null,
    repoPath: "/repo",
    git,
  });
  assert.ok(res.prompt.includes("file.txt"));
});
