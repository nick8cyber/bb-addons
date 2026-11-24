/**
 * §32.5.7 (PLUG-398, регрессия GH-684 / PLUG-397): один гейт §31.9 на обоих
 * путях. Тест параметризован по путям `run-queue` и прямой `delegate`:
 * одна и та же задача, одни и те же ревью — одинаковый исход и один и тот
 * же `spec_sha` в договоре.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeTempDir } from "./helpers/temp.js";
import type { BbCli } from "../src/bb-cli.js";
import type { CmdRunner } from "../src/cmd.js";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import { parsePolicy } from "../src/policy.js";
import { resolveRepoIdentity } from "../src/spec-gate.js";
import { runRunQueue } from "../src/workgraph.js";
import { runDelegate } from "../src/delegate.js";

const POLICY_TEXT = JSON.stringify({
  version: 1,
  specBeforeCode: true,
  limits: { maxActive: 5 },
  levels: {
    simple: { chain: ["simple"] },
    review: { role: "auditor", chain: ["review-route"] },
  },
  routes: {
    simple: { preset: "simple", provider: "acp-opencode" },
    "review-route": { preset: "auditor", provider: "acp-devin" },
  },
});

function gitRepo(): { dir: string; run: (a: string[]) => string; cmd: CmdRunner } {
  const dir = makeTempDir("orch-gate-parity-");
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", "Tester"]);
  run(["config", "user.email", "test@test.local"]);
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
        return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    },
  };
  return { dir, run, cmd };
}

type Scenario = "reviewed" | "unreviewed";

/** Одна и та же задача и одни и те же ревью для обоих путей. */
async function fixture(scenario: Scenario) {
  const { dir, run, cmd } = gitRepo();
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  writeFileSync(join(dir, "docs/specs/PAR-1.md"), "# Spec base\n");
  run(["add", "."]);
  run(["commit", "-qm", "base"]);
  const baseSha = run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "docs/specs/PAR-1.md"), "# Spec rev 1\n");
  run(["commit", "-qam", "docs: rev 1"]);
  const rev1 = run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "docs/specs/PAR-1.md"), "# Spec rev 2\n");
  run(["commit", "-qam", "docs: rev 2"]);
  const rev2 = run(["rev-parse", "HEAD"]).trim();
  if (scenario === "unreviewed") {
    writeFileSync(join(dir, "docs/specs/PAR-1.md"), "# Spec rev 3, not reviewed\n");
    run(["commit", "-qam", "docs: rev 3"]);
  }
  const repoId = (await resolveRepoIdentity(cmd, dir))!;

  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  store.insertTask({
    taskKey: "PAR-1",
    projectId: "proj_par",
    coordinatorThreadId: "thr_coord",
    route: "simple",
    level: "simple",
    confirmationMode: "auto",
  });
  // два принятых ревью спеки: rev1 и rev2 — «последнее, покрывающее базу» — rev2
  for (const [round, head] of [
    [1, rev1],
    [2, rev2],
  ] as const) {
    const d = store.insert({
      taskKey: "PAR-1",
      projectId: "proj_par",
      coordinatorThreadId: "thr_coord",
      level: "review",
      route: "review-route",
      preset: "auditor",
      provider: "acp-devin",
      round,
      continueFrom: head,
      explicitRoute: false,
      noCode: true,
      attach: JSON.stringify({
        kind: "spec_review",
        taskKey: "PAR-1",
        projectId: "proj_par",
        repo: repoId,
        baseSha,
        headSha: head,
        specPaths: ["docs/specs/PAR-1.md"],
      }),
    });
    store.setStatus(d.id, "running");
    store.setStatusIf(d.id, "running", "done", {
      reviewVerdict: { verdict: "OK", blockers: 0 },
    } as any);
  }
  return { dir, cmd, store, rev2 };
}

const fakeCli: BbCli = {
  run: async (args: string[]) => {
    if (args[0] === "tasks" && args[1] === "preset") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          preset: { providerId: "acp-opencode", permissionMode: "full", environmentKind: "host" },
        }),
        stderr: "",
      };
    }
    if (args[0] === "tasks" && args[1] === "show") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          task: { id: "t_par", key: "PAR-1", title: "PAR-1", status: "in_progress" },
          project: { id: "proj_par", linkedBbProjectId: "proj_par" },
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "{}", stderr: "" };
  },
};

type Outcome = { ok: boolean; code?: string; dispatched: number; specSha: string | null };

const PATHS: Record<"run-queue" | "delegate", (f: Awaited<ReturnType<typeof fixture>>) => Promise<Outcome>> = {
  "run-queue": async ({ dir, cmd, store }) => {
    const pol = parsePolicy(POLICY_TEXT);
    let dispatched = 0;
    const warnings: string[] = [];
    await runRunQueue({
      store,
      workGraphMode: "strict",
      repoRoot: dir,
      mergeBaseBranch: "main",
      cmd,
      policy: pol.policy,
      approvalMode: "auto",
      log: { warn: (m) => warnings.push(m) },
      dispatchNode: async () => {
        dispatched++;
        return { ok: true };
      },
    });
    const task = store.getTask("PAR-1")!;
    const blocked = /spec-gate-violation/.test(
      String(JSON.parse(task.payload ?? "{}").spec_gate_error ?? warnings.join("\n")),
    );
    const moved = task.node === "code";
    return {
      ok: moved && !blocked,
      code: blocked ? "spec-gate-violation" : undefined,
      dispatched,
      specSha: store.getSpecContract("PAR-1")?.spec_sha ?? null,
    };
  },
  delegate: async ({ dir, cmd, store }) => {
    const pol = parsePolicy(POLICY_TEXT);
    let dispatched = 0;
    try {
      await runDelegate(
        {
          taskKey: "PAR-1",
          level: "simple",
          caller: {
            threadId: "thr_coord",
            parentThreadId: null,
            title: "coordinator",
            originPluginId: null,
            projectId: "proj_par",
          },
        },
        {
          store,
          policy: () => pol.policy,
          loadPolicy: async () => pol,
          bbCli: fakeCli,
          threads: {
            spawn: async () => {
              dispatched++;
              return { id: `thr_exec_${dispatched}` };
            },
          } as any,
          probes: { roleByThreadId: () => "orchestrator" },
          primaryHostId: async () => "host_1",
          cmd,
          repoRoot: dir,
          workGraphMode: "strict",
          approvalMode: () => "auto",
        } as any,
      );
      return { ok: true, dispatched, specSha: store.getSpecContract("PAR-1")?.spec_sha ?? null };
    } catch (e: any) {
      return {
        ok: false,
        code: e?.code,
        dispatched,
        specSha: store.getSpecContract("PAR-1")?.spec_sha ?? null,
      };
    }
  },
};

for (const scenario of ["reviewed", "unreviewed"] as const) {
  const outcomes = new Map<string, Outcome>();
  for (const path of ["run-queue", "delegate"] as const) {
    test(`§32.5.7 one spec gate on both paths [${path}] — ${scenario}`, async () => {
      const f = await fixture(scenario);
      const out = await PATHS[path](f);
      // ревизии разных фикстур различны — сравниваем по роли ревизии
      outcomes.set(path, { ...out, specSha: out.specSha === f.rev2 ? "rev2" : out.specSha });
      if (scenario === "reviewed") {
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.equal(out.dispatched, 1);
        assert.equal(out.specSha, f.rev2, "договор — на последнем принятом ревью, покрывающем базу");
      } else {
        assert.equal(out.ok, false, JSON.stringify(out));
        assert.equal(out.code, "spec-gate-violation");
        assert.equal(out.dispatched, 0);
        assert.equal(out.specSha, null);
      }
    });
  }
  test(`§32.5.7 both paths give the same outcome and spec_sha — ${scenario}`, () => {
    const a = outcomes.get("run-queue");
    const b = outcomes.get("delegate");
    assert.ok(a && b, "оба пути выполнены");
    assert.equal(a.ok, b.ok);
    assert.equal(a.code, b.code);
    assert.equal(a.dispatched, b.dispatched);
    assert.equal(a.specSha, b.specSha);
  });
}
