import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import type { BbCli, BbCliResult } from "../src/bb-cli.js";
import type { Policy, PolicyLoad } from "../src/policy.js";
import {
  createWatchdog,
  type WatchdogDeps,
  type WatchdogThreadDto,
  type WatchdogThreadEvent,
} from "../src/watchdog.js";
import { makeTempDir } from "./helpers/temp.js";

/** §5.6 (r33.11): the coordinator watchdog — idle reminders at
 * cumulative N/3N/7N from the idle anchor, the owner escalation at
 * 11N, the productive-action and user-message resets. */

const T0 = 1_700_000_000_000;
const ok = (stdout = ""): BbCliResult => ({ exitCode: 0, stdout, stderr: "" });

const ev = (
  seq: number,
  type: string,
  createdAt: number,
  data: Record<string, unknown> = {},
): WatchdogThreadEvent => ({ seq, type, createdAt, data });

const request = (
  seq: number,
  createdAt: number,
  text: string,
  kind: string | null = "unlabeled",
): WatchdogThreadEvent =>
  ev(seq, "client/turn/requested", createdAt, {
    systemMessageKind: kind,
    input: [{ type: "text", text }],
  });

function makeHarness(
  opts: {
    timing?: Policy["timing"];
    limits?: Policy["limits"];
    workGraphMode?: "off" | "observe" | "strict";
    upstream?: WatchdogDeps["upstream"];
  } = {},
) {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const store = new DelegationStore(db);
  const cliCalls: string[][] = [];
  const taskStatuses = new Map<string, string>();
  const cli: BbCli = {
    run: async (args) => {
      cliCalls.push(args);
      const key = args.join(" ");
      if (key.startsWith("tasks project list")) {
        return ok(
          JSON.stringify({
            projects: [
              { prefix: "PLUG", linkedBbProjectId: "proj_bb" },
              { prefix: "OTHER", linkedBbProjectId: "proj_other" },
            ],
          }),
        );
      }
      if (key.startsWith("tasks show")) {
        if (trackerDown.v) {
          return { exitCode: 1, stdout: "", stderr: "tracker down (test)" };
        }
        const status = taskStatuses.get(args[2]!) ?? "in_progress";
        return ok(JSON.stringify({ task: { key: args[2], status } }));
      }
      if (key.startsWith("tasks list")) {
        return ok(
          JSON.stringify({
            tasks: backlogKeys.map((k) => ({ key: k, status: "backlog" })),
          }),
        );
      }
      if (key.startsWith("project list")) {
        return ok(JSON.stringify(bbProjects));
      }
      return ok();
    },
  };
  const backlogKeys: string[] = [];
  /** §5.6 (r34.1): `bb project list --json` rows for
   * `settingsProjectId` inside the upstream-reconcile pass. */
  const bbProjects: unknown[] = [];
  /** §5.6 (r34.1): `tasks show` failure switch for stale-on-error
   * and warmup-on-failure tests. */
  const trackerDown = { v: false };
  const sends: { threadId: string; input: { text?: string }[] }[] = [];
  const eventLog = new Map<string, WatchdogThreadEvent[]>();
  const threadDtos = new Map<string, WatchdogThreadDto>();
  const threads = {
    get: async ({ threadId }: { threadId: string }) => {
      const dto = threadDtos.get(threadId);
      if (!dto) throw new Error(`thread not found: ${threadId}`);
      return dto;
    },
    events: {
      list: async (args: {
        threadId: string;
        afterSeq?: string;
        beforeSeq?: string;
        order?: "asc" | "desc";
        limit?: string;
        types?: readonly string[];
      }) => {
        let rows = (eventLog.get(args.threadId) ?? []).slice();
        if (args.types?.length) {
          rows = rows.filter((r) => args.types!.includes(r.type));
        }
        if (args.afterSeq !== undefined) {
          rows = rows.filter((r) => r.seq > Number(args.afterSeq));
        }
        if (args.beforeSeq !== undefined) {
          rows = rows.filter((r) => r.seq <= Number(args.beforeSeq));
        }
        rows.sort((a, b) =>
          args.order === "desc" ? b.seq - a.seq : a.seq - b.seq,
        );
        if (args.limit) rows = rows.slice(0, Number(args.limit));
        return rows;
      },
    },
    queuedMessages: { list: async () => [] },
    send: async (args: {
      threadId: string;
      mode: "queue-if-active";
      input: { type: string; text?: string }[];
    }) => {
      sends.push({
        threadId: args.threadId,
        input: args.input as { text?: string }[],
      });
      // A delivered message opens a turn — the thread leaves `idle`.
      const dto = threadDtos.get(args.threadId);
      if (dto) dto.status = "active";
      return {};
    },
    stop: async () => ({}),
    output: async () => ({ output: null }),
    update: async () => ({}),
  };
  let nowMs = T0;
  const policy: Policy = {
    version: 1,
    levels: {},
    routes: {},
    ...(opts.timing ? { timing: opts.timing } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
  };
  const deps: WatchdogDeps = {
    store,
    bbCli: cli,
    threads,
    loadPolicy: async (): Promise<PolicyLoad> => ({
      policy,
      errors: [],
      warnings: [],
      unavailableRoutes: [],
    }),
    dispatch: async () => ({ ok: true }) as never,
    finalize: async () => ({ status: "running", setupErrors: [] }),
    retrySetup: async () => [],
    enqueue: async (fn) => fn(),
    now: () => nowMs,
    ...(opts.workGraphMode
      ? { workGraphMode: () => opts.workGraphMode! }
      : {}),
    ...(opts.upstream ? { upstream: opts.upstream } : {}),
  };
  const watchdog = createWatchdog(deps);
  return {
    db,
    store,
    watchdog,
    sends,
    cliCalls,
    eventLog,
    threadDtos,
    backlogKeys,
    taskStatuses,
    bbProjects,
    trackerDown,
    /** §5.6 (r34.1): nudges wait for the first reconcileUpstream
     * attempt — the tracker-cache warm-up gate. Tests that expect a
     * nudge must call this once after setup. */
    warm: () => watchdog.reconcileUpstream(),
    advance: (ms: number) => {
      nowMs += ms;
    },
    /** A delegation row in a terminal state for `coordinator`. */
    doneDelegation: (
      coordinator: string,
      taskKey = "PLUG-1",
      status: "done" | "failed" | "stalled" | "quota" = "done",
      opts: { projectId?: string; resultSha?: string; commits?: number } = {},
    ) => {
      const row = store.insert({
        taskKey,
        projectId: opts.projectId,
        coordinatorThreadId: coordinator,
        level: "simple",
        route: "r",
        preset: "p",
        provider: "acp",
      });
      store.setStatus(row.id, status);
      if (opts.resultSha) {
        store.setRoundResult(row.id, {
          envId: null,
          branch: "bb/result",
          sha: opts.resultSha,
          commits: opts.commits ?? 1,
          dirty: false,
        });
      }
      return row;
    },
    coordinator: (
      id = "thr_c",
      extra: Partial<WatchdogThreadDto> = {},
    ): WatchdogThreadDto => {
      store.setThreadRole(id, "orchestrator", "hook");
      const dto: WatchdogThreadDto = {
        id,
        status: "idle",
        parentThreadId: null,
        projectId: "proj_bb",
        ...extra,
      };
      threadDtos.set(id, dto);
      return dto;
    },
  };
}

const NUDGE_MIN = 5;

test("§5.6: an idle coordinator with a done-unmerged delegation is nudged at cumulative N, 3N, 7N", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.warm();
  // Anchor the idle epoch, then let the pass discover it.
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0, "no nudge before the threshold");
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1, "nudge #1 at N");
  const n1 = h.sends[0]!;
  assert.equal(n1.threadId, "thr_c");
  const t1 = n1.input[0]!.text!;
  assert.match(t1, /^\[orchestrator\] Напоминание \(1\/3\)/);
  assert.match(t1, /PLUG-1/);
  // The nudge-woken turn does not move the anchor — #2 waits for the
  // cumulative 3N of the same quiet spell.
  await h.watchdog.onThreadActive(c);
  c.status = "idle";
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1, "no early nudge #2");
  h.advance(NUDGE_MIN * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 2, "nudge #2 at cumulative 3N");
  assert.match(h.sends[1]!.input[0]!.text!, /\(2\/3\)/);
  // #3 at cumulative 7N.
  await h.watchdog.onThreadActive(c);
  c.status = "idle";
  await h.watchdog.onThreadIdle(c);
  h.advance(3 * NUDGE_MIN * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 2, "no early nudge #3");
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 3, "nudge #3 at cumulative 7N");
  assert.match(h.sends[2]!.input[0]!.text!, /\(3\/3\)/);
});

test("§5.6: at cumulative 11N — escalation to the parent thread", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c", { parentThreadId: "thr_p" });
  threadDtosParent(h, "thr_p");
  h.doneDelegation("thr_c");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  // Burn the three nudges quickly.
  for (const wait of [1, 2, 4]) {
    h.advance(wait * NUDGE_MIN * 60_000 + 1);
    await h.watchdog.checkTimers();
    await h.watchdog.onThreadActive(c);
    c.status = "idle";
    await h.watchdog.onThreadIdle(c);
  }
  assert.equal(h.sends.length, 3);
  h.advance(4 * NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 4, "escalation sent");
  const esc = h.sends[3]!;
  assert.equal(esc.threadId, "thr_p", "escalation goes to the parent");
  assert.match(esc.input[0]!.text!, /^\[orchestrator:alert\]/);
  assert.match(esc.input[0]!.text!, /@thread:thr_c/);
  // Afterwards the watchdog waits silently.
  h.advance(60 * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 4, "no spam after escalation");
});

/** The parent's DTO must resolve for the escalation send. */
function threadDtosParent(
  h: ReturnType<typeof makeHarness>,
  id: string,
) {
  h.threadDtos.set(id, { id, status: "idle" });
}

test("§5.6: a root coordinator escalates via push-notifications", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c", { parentThreadId: null });
  h.doneDelegation("thr_c");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  for (const wait of [1, 2, 4]) {
    h.advance(wait * NUDGE_MIN * 60_000 + 1);
    await h.watchdog.checkTimers();
    await h.watchdog.onThreadActive(c);
    c.status = "idle";
    await h.watchdog.onThreadIdle(c);
  }
  h.advance(4 * NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  const push = h.cliCalls.find((a) => a[0] === "push-notifications");
  assert.ok(push, "push CLI called for a root chat");
  assert.ok(push!.includes("--thread"));
  assert.ok(push!.includes("thr_c"));
});

test("§5.6: a productive plugin call resets the nudge schedule", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  await h.watchdog.onThreadActive(c);
  // The coordinator answers with a productive tool call.
  h.watchdog.markCoordinatorAction("thr_c");
  const w = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w.nudge_count, 0, "counter reset");
  assert.equal(w.escalated_at, null);
});

test("§5.6: a user message in the journal resets the schedule", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  const w0 = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w0.nudge_count, 1);
  // The owner's own line — not a system notice — resets the counter.
  h.eventLog.set("thr_c", [
    request(10, now() + 1, "привет, посмотри делегирования"),
    request(11, now() + 2, "[orchestrator] Напоминание (1/3): …"),
    request(12, now() + 3, "[bb system] child completed"),
  ]);
  c.status = "idle";
  await h.watchdog.onThreadIdle(c);
  h.advance(1000);
  await h.watchdog.checkTimers();
  const w = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w.nudge_count, 0, "user message resets");
});

test("§5.6: running executors make sleeping the contract — no nudge", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  // A NEW active delegation for another task — the coordinator waits.
  h.store.insert({
    taskKey: "PLUG-2",
    coordinatorThreadId: "thr_c",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "acp",
  });
  await h.watchdog.onThreadIdle(c);
  h.advance(60 * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0, "no nudge while an executor runs");
});

test("§5.6 (r34.1): project backlog alone never nudges — the criterion is gone", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.backlogKeys.push("PLUG-77", "PLUG-78");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0, "backlog alone does not nudge in r34.1");
});

test("§5.6: no work at all — the coordinator sleeps undisturbed", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  await h.watchdog.onThreadIdle(c);
  h.advance(60 * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0);
  const w = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w.nudge_count, 0);
});

test("§5.6: a non-orchestrator thread is never watched", async () => {
  const h = makeHarness();
  h.store.setThreadRole("thr_x", "executor", "hook");
  h.threadDtos.set("thr_x", { id: "thr_x", status: "idle" });
  h.doneDelegation("thr_x");
  await h.watchdog.onThreadIdle({ id: "thr_x", status: "idle" });
  h.advance(60 * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0);
});

test("§5.6: timing.coordinatorWatchdogEnabled=false disables the pass", async () => {
  const h = makeHarness({
    timing: { coordinatorWatchdogEnabled: false },
  });
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  h.advance(60 * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0);
});

test("§5.6: work cleared — the schedule resets", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  const row = h.doneDelegation("thr_c");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  // The task got merged — nothing pending any more.
  h.store.setMerged(row.id, { into: "main", sha: "abc" });
  c.status = "idle";
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  const w = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w.nudge_count, 0, "cleared work resets");
  assert.equal(w.idle_since, null);
});

test("§5.6: active releases (auditing, publishing, published) exclude task from pending", async () => {
  const h = makeHarness();
  h.coordinator("thr_c");
  const row = h.doneDelegation("thr_c");
  const pendingBefore = h.store.coordinatorPendingTasks("thr_c");
  assert.equal(pendingBefore.length, 1);

  for (const st of ["auditing", "publishing", "published"]) {
    h.db.prepare("DELETE FROM releases").run();
    h.db
      .prepare(
        `INSERT INTO releases (
          task_key, project_id, coordinator_thread_id, repo_path, branch,
          target_action, target_branch, status, created_at, updated_at
        ) VALUES (?, 'proj_1', 'thr_c', '/repo', 'main', 'push', 'main', ?, 1, 1)`,
      )
      .run(row.task_key, st);

    const pendingAfter = h.store.coordinatorPendingTasks("thr_c");
    assert.equal(pendingAfter.length, 0, `${st} release excludes from pending`);
  }
});

test("§5.6: settled no-code delegation (done, no_code=1, result_commits=0) is not pending, but failed is pending", async () => {
  const h = makeHarness();
  h.coordinator("thr_c");
  const row = h.store.insert({
    taskKey: "PLUG-NC",
    coordinatorThreadId: "thr_c",
    level: "simple",
    route: "r",
    preset: "p",
    provider: "acp",
    noCode: true,
  });
  h.store.setStatus(row.id, "done");
  const pendingDone = h.store.coordinatorPendingTasks("thr_c");
  assert.equal(pendingDone.length, 0, "settled no-code done excluded from pending");

  // But if it failed, it needs attention (reissue or cancel)
  h.store.setStatus(row.id, "failed");
  const pendingFailed = h.store.coordinatorPendingTasks("thr_c");
  assert.equal(pendingFailed.length, 1, "failed no-code is pending");
});

test("§5.6: agent tell messages do not reset the nudge schedule", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  const w0 = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w0.nudge_count, 1);

  // An incoming message from another agent (tell) must NOT reset the schedule
  h.eventLog.set("thr_c", [
    {
      seq: 20,
      type: "client/turn/requested",
      createdAt: now() + 1,
      data: {
        senderThreadId: "thr_a",
        source: "tell",
        input: [{ type: "text", text: "[bb message from thread:thr_a] ping" }],
      },
    },
  ]);
  c.status = "idle";
  await h.watchdog.onThreadIdle(c);
  h.advance(1000);
  await h.watchdog.checkTimers();
  const w1 = h.store.coordinatorWatchdogGet("thr_c")!;
  assert.equal(w1.nudge_count, 1, "agent tell does not reset nudge schedule");
});

test("§5.6: escalation occurs after +4N even with coordinatorMaxNudges=1", async () => {
  const h = makeHarness({ timing: { coordinatorMaxNudges: 1 } });
  h.coordinator("thr_p");
  const c = h.coordinator("thr_c", { parentThreadId: "thr_p" });
  h.doneDelegation("thr_c");
  await h.warm();
  await h.watchdog.onThreadIdle(c);

  // At 1N (5 min) -> nudge 1
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0]!.threadId, "thr_c");

  // At 3N (15 min) -> no escalation yet (must wait +4N after nudge 1)
  c.status = "idle";
  h.advance(2 * NUDGE_MIN * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1, "no premature escalation at 3N when maxNudges=1");

  // At 5N (25 min = 1N + 4N) -> escalation to parent
  h.advance(2 * NUDGE_MIN * 60_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1]!.threadId, "thr_p", "escalation at 1N + 4N");
});

test("§5.6 (r34.1): reminder lists pending delegations only — backlog keys are not pending work", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c", "PLUG-10");
  await h.warm();
  h.backlogKeys.push("PLUG-99");
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  const text = h.sends[0]!.input[0]!.text!;
  assert.match(text, /PLUG-10/);
  assert.doesNotMatch(text, /PLUG-99/);
  // §5.6 п.2 (r34.1): the reminder text is neutral — check the state,
  // do nothing when the tasks are already closed.
  assert.match(text, /Проверь состояние задач/);
  assert.match(text, /ничего не делай/);
});

function now() {
  return Date.now();
}

// ── §5.6 (r34.1, PLUG-317): epoch guard, tracker/upstream reconcile ───

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** Fake `deps.upstream` for the reconcile passes: `repo` must be a real
 * dir (`settingsProjectId` realpaths it), the git shim answers the
 * upstream probes declaratively. The matching `project list` row goes
 * into the harness `bbProjects`. */
function fakeUpstream(opts: {
  repo: string;
  projectId?: string;
  hostId?: string;
  targetTip?: string;
  /** shas that are ancestors of origin/<target>. */
  ancestors?: readonly string[];
  /** shas whose `merge-tree --write-tree` equals the target tree. */
  treeEqual?: readonly string[];
  /** shas absent from the object store (`cat-file -e` fails). */
  missingObjects?: readonly string[];
  fetchFail?: boolean;
}) {
  const projectId = opts.projectId ?? "proj_bb";
  const hostId = opts.hostId ?? "h1";
  const tip = opts.targetTip ?? "f".repeat(40);
  const tree = "e".repeat(40);
  const ancestors = new Set(opts.ancestors ?? []);
  const treeEqual = new Set(opts.treeEqual ?? []);
  const missing = new Set(opts.missingObjects ?? []);
  const gitCalls: string[][] = [];
  const dep: WatchdogDeps["upstream"] = {
    projects: async () => [
      {
        id: projectId,
        sources: [
          { type: "local_path", path: opts.repo, isDefault: true, hostId },
        ],
      },
    ],
    localHostId: () => hostId,
    releaseConfig: () => ({
      config: { defaults: {}, projects: {} },
      empty: false,
      errors: [],
      warnings: [],
    }),
    git: async (_repo, args) => {
      gitCalls.push(args);
      const [a0, a1] = args;
      if (a0 === "worktree") {
        return { exitCode: 0, stdout: `worktree ${opts.repo}\n`, stderr: "" };
      }
      if (a0 === "fetch") {
        return opts.fetchFail
          ? { exitCode: 1, stdout: "", stderr: "fetch failed (test)" }
          : { exitCode: 0, stdout: "", stderr: "" };
      }
      if (a0 === "cat-file") {
        return {
          exitCode: missing.has(args[2]!) ? 1 : 0,
          stdout: "",
          stderr: "",
        };
      }
      if (a0 === "merge-base" && a1 === "--is-ancestor") {
        return {
          exitCode: ancestors.has(args[2]!) ? 0 : 1,
          stdout: "",
          stderr: "",
        };
      }
      if (a0 === "rev-parse") {
        const ref = args.at(-1)!;
        if (ref === "--git-common-dir") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: `${ref.endsWith("^{tree}") ? tree : tip}\n`,
          stderr: "",
        };
      }
      if (a0 === "merge-tree") {
        return {
          exitCode: 0,
          stdout: `${treeEqual.has(args[3]!) ? tree : "d".repeat(40)}\n`,
          stderr: "",
        };
      }
      if (a0 === "remote") {
        return { exitCode: 0, stdout: "git@h:p.git\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const projectItem = {
    id: projectId,
    sources: [
      { type: "local_path", path: opts.repo, isDefault: true, hostId },
    ],
  };
  return { dep, gitCalls, projectItem };
}

test("§5.6 (r34.1) п.1: a row finished before installed_at never nudges; reconcileHistoryOnce still marks the upstream landing once", async () => {
  const repo = makeTempDir("up-");
  const up = fakeUpstream({ repo, ancestors: [SHA_A] });
  const h = makeHarness({ upstream: up.dep });
  h.bbProjects.push(up.projectItem);
  const c = h.coordinator("thr_c");
  const row = h.doneDelegation("thr_c", "PLUG-1", "done", {
    projectId: "proj_bb",
    resultSha: SHA_A,
  });
  // Backdate the finish — before the watchdog's epoch.
  h.db
    .prepare("UPDATE delegations SET finished_at = ? WHERE id = ?")
    .run(T0 - 1_000, row.id);
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers(); // stamps installed_at = T0
  await h.warm();
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0, "historical row — no nudge");
  await h.watchdog.reconcileHistory();
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.merge_status, "merged-upstream");
  assert.equal(fresh.merged_into, "origin/main");
  assert.equal(fresh.merged_sha, SHA_A, "ancestor keeps the result sha");
  const callsAfterFirst = up.gitCalls.length;
  await h.watchdog.reconcileHistory();
  assert.equal(
    up.gitCalls.length,
    callsAfterFirst,
    "coordinator_history_reconciled_at blocks a second sweep",
  );
});

test("§5.6 (r34.1) п.2/2b: tracker-closed tasks leave the pending set — no nudge (done and failed rows)", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c", "PLUG-1", "done");
  h.doneDelegation("thr_c", "PLUG-2", "failed");
  h.taskStatuses.set("PLUG-1", "done");
  h.taskStatuses.set("PLUG-2", "canceled");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0);
});

test("§5.6 (r34.1) п.3: a result already on origin/<target> — the pass marks merged-upstream and the watchdog sleeps", async () => {
  const repo = makeTempDir("up-");
  const up = fakeUpstream({ repo, ancestors: [SHA_A] });
  const h = makeHarness({ upstream: up.dep });
  h.bbProjects.push(up.projectItem);
  const c = h.coordinator("thr_c");
  const row = h.doneDelegation("thr_c", "PLUG-1", "done", {
    projectId: "proj_bb",
    resultSha: SHA_A,
    commits: 2,
  });
  await h.warm();
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.merge_status, "merged-upstream");
  assert.equal(fresh.merged_into, "origin/main");
  assert.equal(fresh.merged_sha, SHA_A);
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0);
});

test("§5.6 (r34.1) п.3: a squash-landed result (merge-tree equal) — merged_sha is the target tip", async () => {
  const repo = makeTempDir("up-");
  const up = fakeUpstream({ repo, targetTip: SHA_B, treeEqual: [SHA_A] });
  const h = makeHarness({ upstream: up.dep });
  h.bbProjects.push(up.projectItem);
  h.coordinator("thr_c");
  const row = h.doneDelegation("thr_c", "PLUG-1", "done", {
    projectId: "proj_bb",
    resultSha: SHA_A,
    commits: 3,
  });
  await h.warm();
  const fresh = h.store.get(row.id)!;
  assert.equal(fresh.merge_status, "merged-upstream");
  assert.equal(fresh.merged_sha, SHA_B, "squash records the target tip");
});

test("§5.6 (r34.1) п.14: a landing on a NON-target branch is not merged-upstream — the task stays pending", async () => {
  const repo = makeTempDir("up-");
  const up = fakeUpstream({ repo }); // nothing matches origin/main
  const h = makeHarness({ upstream: up.dep });
  h.bbProjects.push(up.projectItem);
  const c = h.coordinator("thr_c");
  const row = h.doneDelegation("thr_c", "PLUG-1", "done", {
    projectId: "proj_bb",
    resultSha: SHA_A,
  });
  await h.warm();
  assert.equal(h.store.get(row.id)!.merge_status, null);
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1, "still pending — the nudge comes");
});

test("§5.6 (r34.1) п.4/4b: a coordinator quiet over 24h is never woken; tracker comments and automation pings are not activity", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers(); // back-scan → last_activity_at = T0
  assert.equal(
    h.store.coordinatorWatchdogGet("thr_c")!.last_activity_at,
    T0,
  );
  h.eventLog.set("thr_c", [
    request(5, T0 + 3_600_000, "New comment on task PLUG-1: ping"),
    request(6, T0 + 3_700_000, "[bb automation check] heartbeat"),
    request(7, T0 + 3_800_000, "[orchestrator] Напоминание (1/3)"),
  ]);
  h.advance(25 * 3_600_000);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0, "the 24 h gate blocks the nudge");
  assert.equal(
    h.store.coordinatorWatchdogGet("thr_c")!.last_activity_at,
    T0,
    "system events do not count as owner activity",
  );
});

test("§5.6 (r34.1) п.10: nudges and reconcile passes do not extend last_activity_at", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  const act0 = h.store.coordinatorWatchdogGet("thr_c")!.last_activity_at;
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  assert.equal(
    h.store.coordinatorWatchdogGet("thr_c")!.last_activity_at,
    act0,
    "the reminder itself is not activity",
  );
  await h.warm();
  assert.equal(
    h.store.coordinatorWatchdogGet("thr_c")!.last_activity_at,
    act0,
    "the reconcile pass is not activity",
  );
});

test("§5.6 (r34.1) п.11: coordinatorWatchdogEnabled off→on restamps installed_at — the disabled window stays history", async () => {
  const timing = { coordinatorWatchdogEnabled: true };
  const h = makeHarness({ timing });
  const c = h.coordinator("thr_c");
  await h.watchdog.checkTimers();
  assert.equal(
    h.store.metaGet("coordinator_watchdog_installed_at"),
    String(T0),
  );
  timing.coordinatorWatchdogEnabled = false;
  h.advance(60_000);
  await h.watchdog.checkTimers();
  assert.equal(
    h.store.metaGet("coordinator_watchdog_enabled_last"),
    "false",
  );
  const row = h.doneDelegation("thr_c"); // finished while disabled
  h.db
    .prepare("UPDATE delegations SET finished_at = ? WHERE id = ?")
    .run(T0 + 30_000, row.id);
  timing.coordinatorWatchdogEnabled = true;
  h.advance(60_000);
  await h.watchdog.checkTimers(); // restamps installed_at = T0+120s
  assert.equal(
    h.store.metaGet("coordinator_watchdog_installed_at"),
    String(T0 + 120_000),
  );
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0, "the disabled window's row is history");
});

test("§5.6 (r34.1) п.12: no nudge before the tracker warmup; a failed first pass still opens the gate (stale-on-error)", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0, "unwarmed — no nudge");
  h.trackerDown.v = true;
  await h.warm(); // fails but completes the warmup flag
  h.trackerDown.v = false;
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1, "a failed first pass still opens the gate");
});

test("§5.6 (r34.1) п.12: a tracker error keeps the last known status (stale-on-error)", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  h.taskStatuses.set("PLUG-1", "done");
  await h.warm(); // caches "done"
  h.trackerDown.v = true;
  await h.watchdog.reconcileUpstream(); // fails — the cached status stays
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 0, "cached done still closes the task");
});

test("§5.6 (r34.1) п.15: last_activity_at=0 — the back-scan finds the owner's turn and the schedule runs", async () => {
  const h = makeHarness();
  const c = h.coordinator("thr_c");
  h.doneDelegation("thr_c");
  h.eventLog.set("thr_c", [request(3, T0 - 3_600_000, "привет")]);
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  assert.equal(
    h.store.coordinatorWatchdogGet("thr_c")!.last_activity_at,
    T0 - 3_600_000,
    "the back-scan restored the owner turn",
  );
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
});

test("§5.6 (r34.1) п.5: finished_at lifecycle — terminal stamps it, revive clears, re-terminal stamps again", () => {
  const h = makeHarness();
  const row = h.doneDelegation("thr_c");
  const first = h.store.get(row.id)!.finished_at;
  assert.ok(first != null && first > 0, "done stamps finished_at");
  h.store.revive(row.id);
  assert.equal(
    h.store.get(row.id)!.finished_at,
    null,
    "revive to running clears it",
  );
  h.store.setStatus(row.id, "failed");
  const second = h.store.get(row.id)!.finished_at;
  assert.ok(second != null && second >= first!, "re-terminal stamps again");
});

test("§5.6 (r34.1/r34): work graph on — only intervention queue states wake the coordinator", async () => {
  const h = makeHarness({ workGraphMode: "strict" });
  const c = h.coordinator("thr_c");
  const enqueue = (key: string, status: string) =>
    h.db
      .prepare(
        `INSERT INTO task_queue (
          task_key, project_id, coordinator_thread_id, route, level,
          node, status, entered_at, created_at, updated_at
        ) VALUES (?, 'proj_bb', 'thr_c', 'feature', 'complex', 'code', ?, 1, 1, 1)`,
      )
      .run(key, status);
  // A queued graph row is the run-queue's business — the watchdog sleeps.
  enqueue("PLUG-5", "queued");
  // A blocked graph row is the intervention state — it wakes.
  enqueue("PLUG-6", "blocked");
  await h.warm();
  await h.watchdog.onThreadIdle(c);
  await h.watchdog.checkTimers();
  h.advance(NUDGE_MIN * 60_000 + 1);
  await h.watchdog.checkTimers();
  assert.equal(h.sends.length, 1);
  const text = h.sends[0]!.input[0]!.text!;
  assert.match(text, /PLUG-6/);
  assert.doesNotMatch(text, /PLUG-5/);
});
