import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.js";
import type { CmdRunner } from "../src/cmd.js";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import { makeTempDir } from "./helpers/temp.js";
import {
  parseWorkGraphProjects,
  resolveWorkGraphMode,
  normalizeWorkGraphMode,
  computeEffectiveWorkGraphMode,
  shouldShowApprovalMenu,
  resolveTaskProjectId,
  assertGraphAllowsDirectAction,
  runRunQueue,
  runEnqueue,
  type WorkGraphMode,
} from "../src/workgraph.js";

function createTestStore(): DelegationStore {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  return new DelegationStore(db);
}

test("parseWorkGraphProjects & resolveWorkGraphMode helper unit tests", () => {
  // Empty or invalid inputs
  assert.deepEqual(parseWorkGraphProjects(null), {});
  assert.deepEqual(parseWorkGraphProjects(undefined), {});
  assert.deepEqual(parseWorkGraphProjects(""), {});
  assert.deepEqual(parseWorkGraphProjects("   "), {});
  assert.deepEqual(parseWorkGraphProjects("not json"), {});
  assert.deepEqual(parseWorkGraphProjects(123), {});
  assert.deepEqual(parseWorkGraphProjects([]), {});

  // Valid JSON string
  const jsonStr = JSON.stringify({
    proj_a: "strict",
    proj_b: "off",
    proj_c: "shadow",
    proj_d: "INVALID",
    proj_e: 42,
  });
  assert.deepEqual(parseWorkGraphProjects(jsonStr), {
    proj_a: "strict",
    proj_b: "off",
    proj_c: "shadow",
  });

  // Object input with whitespace / uppercase
  assert.deepEqual(
    parseWorkGraphProjects({
      " proj_a ": " STRICT ",
      proj_b: "OFF",
      proj_c: "shadow",
      proj_invalid: "unknown",
    }),
    {
      proj_a: "strict",
      proj_b: "off",
      proj_c: "shadow",
    },
  );

  // resolveWorkGraphMode resolution
  const map = { proj_a: "strict" as const, proj_b: "off" as const };
  assert.equal(resolveWorkGraphMode("proj_a", "off", map), "strict");
  assert.equal(resolveWorkGraphMode("proj_b", "strict", map), "off");
  assert.equal(resolveWorkGraphMode("proj_unknown", "shadow", map), "shadow");
  assert.equal(resolveWorkGraphMode(null, "strict", map), "strict");
  assert.equal(resolveWorkGraphMode(undefined, undefined, map), "off");
});

test("3-step order of task project resolution: 1. task_queue -> 2. delegations -> 3. tracker", async () => {
  const store = createTestStore();
  const t0 = 1_000_000;

  // Step 3 alone: only tracker has the project
  const trackerOnly = {
    getTask: (k: string) => (k === "TASK-3" ? { projectId: "proj_from_tracker" } : null),
  };
  assert.equal(await resolveTaskProjectId(store, "TASK-3", trackerOnly), "proj_from_tracker");

  // Step 2 over step 3: delegations beats tracker
  store.insert({
    taskKey: "TASK-2",
    taskId: "id_2",
    projectId: "proj_from_delegation",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "preset_1",
    provider: "provider_1",
    round: 1,
  });
  const trackerOverride = {
    getTask: (k: string) => ({ projectId: "proj_from_tracker_ignored" }),
  };
  assert.equal(await resolveTaskProjectId(store, "TASK-2", trackerOverride), "proj_from_delegation");

  // Step 1 over step 2 & 3: task_queue beats both
  store.insertTask(
    {
      taskKey: "TASK-1",
      projectId: "proj_from_queue",
      coordinatorThreadId: "thr_coord",
      route: "simple",
      level: "simple",
      confirmationMode: "auto",
    },
    t0,
  );
  store.insert({
    taskKey: "TASK-1",
    taskId: "id_1",
    projectId: "proj_from_del_ignored",
    coordinatorThreadId: "thr_coord",
    level: "simple",
    route: "simple",
    preset: "preset_1",
    provider: "provider_1",
    round: 1,
  });
  assert.equal(await resolveTaskProjectId(store, "TASK-1", trackerOverride), "proj_from_queue");
});

test("1) Тест изоляции strict и off: Проект A в strict, Проект B в off", async () => {
  const store = createTestStore();
  const projectsMap = {
    proj_a: "strict" as const,
    proj_b: "off" as const,
  };
  const tracker = {
    getTask: (key: string) => {
      if (key === "TASK-B") return { projectId: "proj_b" };
      if (key === "TASK-A") return { projectId: "proj_a" };
      return null;
    },
  };

  // Direct action on Task B (project B is in off): succeeds without error
  await assert.doesNotReject(async () => {
    await assertGraphAllowsDirectAction(store, "TASK-B", "off", {
      command: "delegate",
      projectsMap,
      tracker,
    });
  });

  // Direct action on Task A (project A is in strict, task not enqueued): blocked with graph-required
  await assert.rejects(
    async () => {
      await assertGraphAllowsDirectAction(store, "TASK-A", "off", {
        command: "delegate",
        projectsMap,
        tracker,
      });
    },
    (e: any) => e.code === "graph-required",
  );
});

test("2) Тест тишины наблюдателя при off: прямой вызов оставляет task_transitions пустым", async () => {
  const store = createTestStore();
  const projectsMap = {
    proj_b: "off" as const,
    proj_a: "shadow" as const,
  };
  const tracker = {
    getTask: (key: string) => {
      if (key === "TASK-B") return { projectId: "proj_b" };
      if (key === "TASK-A") return { projectId: "proj_a" };
      return null;
    },
  };

  // Direct calls on Task B in off mode
  await assertGraphAllowsDirectAction(store, "TASK-B", "shadow", {
    command: "delegate",
    projectsMap,
    tracker,
  });
  await assertGraphAllowsDirectAction(store, "TASK-B", "shadow", {
    command: "merge",
    projectsMap,
    tracker,
  });
  await assertGraphAllowsDirectAction(store, "TASK-B", "shadow", {
    command: "release",
    projectsMap,
    tracker,
  });

  // Absolutely no transitions written for TASK-B
  const transitionsB = store.listTransitions("TASK-B");
  assert.equal(transitionsB.length, 0);

  // In contrast, Task A in shadow mode does record a mirror transition
  await assertGraphAllowsDirectAction(store, "TASK-A", "shadow", {
    command: "delegate",
    projectsMap,
    tracker,
  });
  const transitionsA = store.listTransitions("TASK-A");
  assert.equal(transitionsA.length, 1);
  assert.equal(transitionsA[0].reason, "task-not-enqueued");
});

test("3) Тест неопределённого проекта: задача берёт глобальный workGraph и логирует предупреждение", async () => {
  const store = createTestStore();
  const warnings: string[] = [];
  const log = {
    warn: (msg: string) => {
      warnings.push(msg);
    },
  };

  // Undetermined task with global mode strict -> blocks with graph-required and logs warning
  await assert.rejects(
    async () => {
      await assertGraphAllowsDirectAction(store, "UNDETERMINED-1", "strict", {
        command: "delegate",
        log,
      });
    },
    (e: any) => e.code === "graph-required",
  );

  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /orchestrator: task UNDETERMINED-1 project undetermined; falling back to global workGraph mode \(strict\)/,
  );

  // Undetermined task with global mode off -> succeeds silently and logs warning
  warnings.length = 0;
  await assert.doesNotReject(async () => {
    await assertGraphAllowsDirectAction(store, "UNDETERMINED-2", "off", {
      command: "delegate",
      log,
    });
  });

  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /orchestrator: task UNDETERMINED-2 project undetermined; falling back to global workGraph mode \(off\)/,
  );
});

test("4) Тест наследования от глобального режима при отсутствии явного переопределения проекта", async () => {
  const store = createTestStore();
  const projectsMap = {
    proj_a: "strict" as const,
    proj_b: "off" as const,
    // proj_c is deliberately omitted
  };
  const tracker = {
    getTask: (key: string) => (key === "TASK-C" ? { projectId: "proj_c" } : null),
  };

  // With global mode strict, Task C inherits strict -> blocks with graph-required
  await assert.rejects(
    async () => {
      await assertGraphAllowsDirectAction(store, "TASK-C", "strict", {
        command: "delegate",
        projectsMap,
        tracker,
      });
    },
    (e: any) => e.code === "graph-required",
  );

  // With global mode off, Task C inherits off -> succeeds without error
  await assert.doesNotReject(async () => {
    await assertGraphAllowsDirectAction(store, "TASK-C", "off", {
      command: "delegate",
      projectsMap,
      tracker,
    });
  });
});

test("5) Тест на асинхронный resolveTaskProjectId с bbCli/tracker и унифицированный приоритет полей", async () => {
  const store = createTestStore();

  // A. Async tracker returning Promise
  const trackerAsync = {
    getTask: async (k: string) => {
      await new Promise((r) => setTimeout(r, 1));
      return { task: { projectId: "proj_from_async_tracker" } };
    },
  };
  assert.equal(
    await resolveTaskProjectId(store, "ASYNC-1", trackerAsync),
    "proj_from_async_tracker",
  );

  // B. Async bbCli mock runner
  const fakeBbCli = {
    run: async (args: string[]) => {
      assert.deepEqual(args, ["tasks", "show", "CLI-1", "--json"]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          task: { projectId: "01JTASKULID00000000000000" },
          project: { linkedBbProjectId: "proj_linked", id: "01JPROJULID0000000000000" },
        }),
        stderr: "",
      };
    },
  };
  assert.equal(
    await resolveTaskProjectId(store, "CLI-1", { bbCli: fakeBbCli }),
    "proj_linked",
  );

  // C. Unified field priority: project.linkedBbProjectId ?? task.projectId ?? project.id
  // 1) project.linkedBbProjectId wins over task.projectId (tracker ULID) and project.id
  const trackerPrio1 = {
    getTask: () => ({
      task: { projectId: "01JTRACKERULID11111111111" },
      project: { linkedBbProjectId: "p1", id: "01JPROJULID1111111111111" },
    }),
  };
  assert.equal(await resolveTaskProjectId(store, "PRIO-1", trackerPrio1), "p1");

  // 2) task.projectId wins over project.id when linkedBbProjectId is absent
  const trackerPrio2 = {
    getTask: () => ({
      task: { projectId: "p2" },
      project: { id: "p3" },
    }),
  };
  assert.equal(await resolveTaskProjectId(store, "PRIO-2", trackerPrio2), "p2");

  // 3) project.id wins when higher priority fields are absent
  const trackerPrio3 = {
    getTask: () => ({
      task: {},
      project: { id: "p3" },
    }),
  };
  assert.equal(await resolveTaskProjectId(store, "PRIO-3", trackerPrio3), "p3");
});

test("6) Тест на enqueue задачи без ctx.projectId (проект берётся из трекера и сохраняется в task_queue.project_id)", async () => {
  const store = createTestStore();
  const tracker = {
    getTask: (k: string) => ({
      task: { projectId: "01JTRACKERTASKULID123456" },
      project: { linkedBbProjectId: "proj_tracker_target", id: "01JTRACKERPROJULID12345" },
    }),
  };

  // Enqueue without ctx.projectId -> must resolve project from tracker and save it
  const res = await runEnqueue(
    { taskKey: "NO-CTX-1" },
    {
      store,
      ctx: {} as any, // NO ctx.projectId
      workGraphMode: "strict",
      tracker,
    },
  );

  assert.equal(res.ok, true);
  assert.equal(
    res.task.project_id,
    "proj_tracker_target",
    "Must save resolved tracker project_id, NOT 'default'",
  );
  const stored = store.getTask("NO-CTX-1");
  assert.equal(
    stored?.project_id,
    "proj_tracker_target",
    "Database must store resolved project_id",
  );

  // Mark task as done so re-enqueue (resetTaskForEnqueue) is allowed
  store.transitionTask({
    taskKey: "NO-CTX-1",
    expectedNode: "start",
    expectedStatus: "queued",
    toNode: "release",
    toStatus: "done",
    actor: "run-queue",
    reason: "done",
  });

  // Re-enqueue (resetTaskForEnqueue) updates project_id
  const res2 = await runEnqueue(
    { taskKey: "NO-CTX-1" },
    {
      store,
      ctx: {} as any,
      workGraphMode: "strict",
      projectId: "proj_updated",
    },
  );

  assert.equal(res2.reissued, true);
  assert.equal(
    res2.task.project_id,
    "proj_updated",
    "Re-enqueue must update project_id in task_queue",
  );
  assert.equal(
    store.getTask("NO-CTX-1")?.project_id,
    "proj_updated",
    "Database record must reflect updated project_id",
  );
});

test("7) Тест на смешанную очередь: одновременно есть задачи из strict-проекта и shadow-проекта в runRunQueue", async () => {
  const store = createTestStore();
  const t0 = 1_000_000;

  // Active task in shadow project: already in code/running
  store.insertTask(
    {
      taskKey: "SHADOW-ACTIVE",
      projectId: "proj_shadow",
      coordinatorThreadId: "thr_shadow_coord",
      route: "simple",
      level: "simple",
      confirmationMode: "auto",
    },
    t0,
  );
  store.transitionTask(
    {
      taskKey: "SHADOW-ACTIVE",
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "code",
      toStatus: "running",
      actor: "coordinator",
      reason: "manual-start",
    },
    t0,
  );

  // Queued task in strict project: start/queued
  store.insertTask(
    {
      taskKey: "STRICT-QUEUED",
      projectId: "proj_strict",
      coordinatorThreadId: "thr_strict_coord",
      route: "simple",
      level: "simple",
      confirmationMode: "auto",
    },
    t0,
  );

  // Queued task in shadow project: start/queued
  store.insertTask(
    {
      taskKey: "SHADOW-QUEUED",
      projectId: "proj_shadow",
      coordinatorThreadId: "thr_shadow_coord",
      route: "simple",
      level: "simple",
      confirmationMode: "auto",
    },
    t0,
  );

  // Waiting approval task in shadow project: owner_gate/waiting_approval
  store.insertTask(
    {
      taskKey: "SHADOW-WAITING",
      projectId: "proj_shadow",
      coordinatorThreadId: "thr_shadow_coord",
      route: "simple",
      level: "simple",
      confirmationMode: "auto",
    },
    t0,
  );
  store.transitionTask(
    {
      taskKey: "SHADOW-WAITING",
      expectedNode: "start",
      expectedStatus: "queued",
      toNode: "owner_gate",
      toStatus: "waiting_approval",
      actor: "coordinator",
      reason: "gate-entry",
    },
    t0,
  );

  // Stalled queued task in shadow project with alarm timestamp in the past
  store.insertTask(
    {
      taskKey: "SHADOW-STALLED",
      projectId: "proj_shadow",
      coordinatorThreadId: "thr_shadow_coord",
      route: "simple",
      level: "simple",
      confirmationMode: "auto",
    },
    t0,
  );
  store.updateTask("SHADOW-STALLED", { node_alarm_at: t0 - 1000 });

  let ownerGateCalled = false;
  const cliCalls: string[] = [];
  const fakeBbCli = {
    run: async (args: string[]) => {
      cliCalls.push(args.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };

  // Run runRunQueue with maxActiveTasks: 1
  const res = await runRunQueue({
    store,
    workGraphMode: "off",
    workGraphProjects: {
      proj_strict: "strict",
      proj_shadow: "shadow",
    },
    maxActiveTasks: 1,
    now: () => t0,
    bbCli: fakeBbCli as any,
    cmd: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    } as any,
    requestOwnerGateInteraction: async () => {
      ownerGateCalled = true;
      return "interaction_shadow";
    },
  });

  // 1. STRICT-QUEUED was successfully taken and started despite SHADOW-ACTIVE being active
  // (because passive shadow task does not consume strict capacity)
  const taskStrict = store.getTask("STRICT-QUEUED");
  assert.equal(taskStrict?.node, "code");
  assert.equal(taskStrict?.status, "running");

  // 2. SHADOW-QUEUED was not auto-started into code
  const taskShadowQueued = store.getTask("SHADOW-QUEUED");
  assert.equal(taskShadowQueued?.node, "start");
  assert.equal(taskShadowQueued?.status, "queued");

  // 3. Step 1b: Shadow tasks in shadow mode without autoAdvance did NOT call requestOwnerGateInteraction
  assert.equal(ownerGateCalled, false, "Shadow task must not request owner interaction");

  // 4. Step 1c: Shadow tasks in shadow mode without autoAdvance did NOT trigger alarm tell messages
  assert.equal(cliCalls.length, 0, "Shadow task must not trigger queue alarm messages");

  // 5. shadow_eval was computed for shadow tasks even though strict tasks were processed in the same queue run!
  const shadowPayload = JSON.parse(taskShadowQueued?.payload ?? "{}");
  assert.ok(shadowPayload.shadow_eval, "shadow_eval must be computed for shadow tasks in mixed queue");
  assert.equal(shadowPayload.shadow_eval.command, "run-queue");
  assert.equal(shadowPayload.shadow_eval.note, "вычислено, но не подключено");
});

test("runRunQueue: задачи проектов в режиме 'off' не продвигаются автоконвейером", async () => {
  const store = createTestStore();
  const t0 = 1_000_000;

  // Task 1 belongs to proj_off (mode off)
  store.insertTask(
    {
      taskKey: "TASK-OFF",
      projectId: "proj_off",
      coordinatorThreadId: "thr_coord_off",
      route: "simple",
      level: "simple",
      confirmationMode: "auto",
    },
    t0,
  );

  // Task 2 belongs to proj_strict (mode strict)
  store.insertTask(
    {
      taskKey: "TASK-STRICT",
      projectId: "proj_strict",
      coordinatorThreadId: "thr_coord_strict",
      route: "simple",
      level: "simple",
      confirmationMode: "auto",
    },
    t0,
  );

  const res = await runRunQueue({
    store,
    workGraphMode: "off",
    workGraphProjects: {
      proj_off: "off",
      proj_strict: "strict",
    },
    maxActiveTasks: 5,
    now: () => t0,
    cmd: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    } as any,
  });

  // TASK-STRICT was started/advanced into code
  const taskStrict = store.getTask("TASK-STRICT");
  assert.equal(taskStrict?.node, "code");
  assert.equal(taskStrict?.status, "running");

  // TASK-OFF was skipped by the auto-pipeline and remained queued at start
  const taskOff = store.getTask("TASK-OFF");
  assert.equal(taskOff?.node, "start");
  assert.equal(taskOff?.status, "queued");
});

test("runRunQueue: изолированный запуск очереди с двумя репозиториями и разными базовыми ветками", async () => {
  const store = createTestStore();
  const t0 = 1_000_000;

  store.insertTask(
    {
      taskKey: "TASK-REPO-A",
      projectId: "proj_a",
      coordinatorThreadId: "thr_coord_a",
      route: "feature",
      level: "medium",
      confirmationMode: "auto",
    },
    t0,
  );

  store.insertTask(
    {
      taskKey: "TASK-REPO-B",
      projectId: "proj_b",
      coordinatorThreadId: "thr_coord_b",
      route: "feature",
      level: "medium",
      confirmationMode: "auto",
    },
    t0,
  );

  const gitCalls: Array<{ repoRoot?: string; args: string[] }> = [];
  const mockCmd: CmdRunner = {
    run: async (_cmd: string, args: string[], opts?: { cwd?: string }) => {
      gitCalls.push({ repoRoot: opts?.cwd, args });
      return { exitCode: 1, stdout: "", stderr: "" };
    },
  };

  await runRunQueue({
    store,
    workGraphMode: "strict",
    workGraphProjects: {
      proj_a: "strict",
      proj_b: "strict",
    },
    maxActiveTasks: 5,
    now: () => t0,
    cmd: mockCmd,
    resolveTaskRepoContext: (task) => {
      if (task.project_id === "proj_a") {
        return { repoRoot: "/repos/project-a", mergeBaseBranch: "main" };
      }
      if (task.project_id === "proj_b") {
        return { repoRoot: "/repos/project-b", mergeBaseBranch: "master" };
      }
      return null;
    },
  });

  // Verify git calls for task A ran in /repos/project-a with main/origin/main
  const aCalls = gitCalls.filter((c) => c.repoRoot === "/repos/project-a");
  assert.ok(aCalls.length > 0, "Git calls for project A must run in /repos/project-a");
  assert.ok(
    aCalls.some((c) => c.args.some((a) => a.includes("task-repo-a"))),
    "Project A git call must reference task-repo-a branch",
  );
  assert.ok(
    aCalls.some((c) => c.args.some((a) => a.includes("origin/main"))),
    "Project A git call must reference origin/main base branch",
  );

  // Verify git calls for task B ran in /repos/project-b with master/origin/master
  const bCalls = gitCalls.filter((c) => c.repoRoot === "/repos/project-b");
  assert.ok(bCalls.length > 0, "Git calls for project B must run in /repos/project-b");
  assert.ok(
    bCalls.some((c) => c.args.some((a) => a.includes("task-repo-b"))),
    "Project B git call must reference task-repo-b branch",
  );
  assert.ok(
    bCalls.some((c) => c.args.some((a) => a.includes("origin/master"))),
    "Project B git call must reference origin/master base branch",
  );

  // Neither project executed in the other project's repository
  assert.ok(
    !aCalls.some((c) => c.args.some((a) => a.includes("task-repo-b") || a.includes("master"))),
    "Project A repo must not process TASK-REPO-B or master",
  );
  assert.ok(
    !bCalls.some((c) => c.args.some((a) => a.includes("task-repo-a") || a.includes("main"))),
    "Project B repo must not process TASK-REPO-A or main",
  );
});

test("runRunQueue: отрицательная проверка — недоступный контекст задачи не выполняет Git-вызовов и не блокирует другие задачи", async () => {
  const store = createTestStore();
  const t0 = 1700000000000;

  // Insert Task 1 (proj_bad, no confirmed repo context)
  store.insertTask(
    {
      taskKey: "TASK-BAD-REPO",
      projectId: "proj_bad",
      coordinatorThreadId: "thr_coord_bad",
      route: "feature",
      level: "medium",
      confirmationMode: "auto",
    },
    t0,
  );

  // Insert Task 2 (proj_good, valid repo context)
  store.insertTask(
    {
      taskKey: "TASK-GOOD-REPO",
      projectId: "proj_good",
      coordinatorThreadId: "thr_coord_good",
      route: "feature",
      level: "medium",
      confirmationMode: "auto",
    },
    t0,
  );

  const gitCalls: Array<{ repoRoot?: string; args: string[] }> = [];
  const warnings: string[] = [];

  const mockCmd: CmdRunner = {
    run: async (_cmd: string, args: string[], opts?: { cwd?: string }) => {
      gitCalls.push({ repoRoot: opts?.cwd, args });
      return { exitCode: 1, stdout: "", stderr: "" };
    },
  };

  await runRunQueue({
    store,
    workGraphMode: "strict",
    workGraphProjects: {
      proj_bad: "strict",
      proj_good: "strict",
    },
    maxActiveTasks: 5,
    now: () => t0,
    cmd: mockCmd,
    log: {
      warn: (msg: string) => warnings.push(msg),
    },
    resolveTaskRepoContext: async (task) => {
      if (task.project_id === "proj_good") {
        return { repoRoot: "/repos/proj-good", mergeBaseBranch: "main" };
      }
      // proj_bad returns null (unavailable repo context)
      return null;
    },
  });

  // Verify warning was recorded for TASK-BAD-REPO without git calls
  assert.ok(
    warnings.some((w) => w.includes("TASK-BAD-REPO") && w.includes("proj_bad")),
    "Warning must be logged for TASK-BAD-REPO indicating unavailable repo context",
  );

  // Zero git calls must be made in any foreign directory or for TASK-BAD-REPO
  assert.ok(
    !gitCalls.some((c) => c.args.some((a) => a.toLowerCase().includes("task-bad-repo"))),
    "TASK-BAD-REPO must have made zero git calls",
  );

  // TASK-GOOD-REPO must have proceeded and run in /repos/proj-good
  const goodCalls = gitCalls.filter((c) => c.repoRoot === "/repos/proj-good");
  assert.ok(goodCalls.length > 0, "TASK-GOOD-REPO must make git calls in /repos/proj-good");
  assert.ok(
    goodCalls.some((c) => c.args.some((a) => a.toLowerCase().includes("task-good-repo"))),
    "Git calls for good task must reference task-good-repo branch",
  );
});

test("connected RPC & UI: projectApprovalMode & taskConfirmationMode с реактивным обновлением при открытом треде", async () => {
  const mockThreads: Record<string, { projectId?: string; environmentId?: string; status?: string }> = {
    thr_in_strict: { projectId: "proj_strict", status: "running" },
    thr_in_off: { projectId: "proj_off", status: "running" },
    thr_unknown_proj: { projectId: "proj_unknown", status: "running" },
  };

  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-rpc-mode-"),
    settings: {
      workGraph: "shadow", // global shadow
      workGraphProjects: JSON.stringify({
        proj_strict: "strict",
        proj_off: "off",
      }),
      language: "ru",
    },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const t = mockThreads[threadId];
          if (!t) throw new Error(`thread ${threadId} not found`);
          return t;
        },
      },
    },
  });

  await createPlugin(host.bb, {
    bbCli: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
  });

  // 1. Thread in off project: overrides global shadow -> off
  const resOffTask = (await host.harness.callRpc("taskConfirmationMode", {
    threadId: "thr_in_off",
  })) as { taskKey: string | null; workGraph: string; projectId: string | null };
  assert.equal(resOffTask.workGraph, "off", "proj_off overrides global shadow with off");
  assert.equal(resOffTask.projectId, "proj_off");

  const resOffProj = (await host.harness.callRpc("projectApprovalMode", {
    threadId: "thr_in_off",
  })) as { workGraph: string; projectId: string | null };
  assert.equal(resOffProj.workGraph, "off", "proj_off projectApprovalMode returns off");
  assert.equal(resOffProj.projectId, "proj_off");

  // 2. Thread in strict project: overrides global shadow -> strict
  const resStrictTask = (await host.harness.callRpc("taskConfirmationMode", {
    threadId: "thr_in_strict",
  })) as { taskKey: string | null; workGraph: string; projectId: string | null };
  assert.equal(resStrictTask.workGraph, "strict", "proj_strict overrides global shadow with strict");
  assert.equal(resStrictTask.projectId, "proj_strict");

  const resStrictProj = (await host.harness.callRpc("projectApprovalMode", {
    threadId: "thr_in_strict",
  })) as { workGraph: string; projectId: string | null };
  assert.equal(resStrictProj.workGraph, "strict", "proj_strict projectApprovalMode returns strict");
  assert.equal(resStrictProj.projectId, "proj_strict");

  // 3. Thread in unknown project: falls back to global shadow
  const resUnknownTask = (await host.harness.callRpc("taskConfirmationMode", {
    threadId: "thr_unknown_proj",
  })) as { taskKey: string | null; workGraph: string; projectId: string | null };
  assert.equal(resUnknownTask.workGraph, "shadow", "unknown project falls back to global shadow");

  // 4. Reactive change while thread is open:
  // Switch proj_off to strict on the fly in settings
  await host.harness.setSettings({
    workGraphProjects: JSON.stringify({
      proj_off: "strict",
      proj_strict: "strict",
    }),
  });

  // Re-check with the same open threadId thr_in_off
  const resUpdatedTask = (await host.harness.callRpc("taskConfirmationMode", {
    threadId: "thr_in_off",
  })) as { taskKey: string | null; workGraph: string; projectId: string | null };
  assert.equal(
    resUpdatedTask.workGraph,
    "strict",
    "After settings change, open thread in proj_off immediately reflects strict",
  );

  const resUpdatedProj = (await host.harness.callRpc("projectApprovalMode", {
    threadId: "thr_in_off",
  })) as { workGraph: string; projectId: string | null };
  assert.equal(
    resUpdatedProj.workGraph,
    "strict",
    "After settings change, projectApprovalMode for open thread reflects strict",
  );

  // 5. Global setting change: change global workGraph from shadow to off
  await host.harness.setSettings({
    workGraph: "off",
  });

  const resGlobalUpdated = (await host.harness.callRpc("taskConfirmationMode", {
    threadId: "thr_unknown_proj",
  })) as { taskKey: string | null; workGraph: string; projectId: string | null };
  assert.equal(
    resGlobalUpdated.workGraph,
    "off",
    "After global setting change to off, thread in unknown project reflects off",
  );
});

test("connected server run-queue resolver: недоступный контекст не использует process.cwd и пропускает Git-вызовы", async () => {
  const gitCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const mockCmdRunner: CmdRunner = {
    run: async (c: string, args: string[], opts?: { cwd?: string }) => {
      gitCalls.push({ cmd: c, args, cwd: opts?.cwd });
      return { exitCode: 0, stdout: "mock-sha\n", stderr: "" };
    },
  };

  const mockThreads: Record<string, { projectId?: string | null; environmentId?: string; status?: string }> = {
    thr_null_proj: { projectId: null, environmentId: "env_unconfirmed", status: "running" },
    thr_valid_proj: { projectId: "proj_valid", environmentId: "env_valid", status: "running" },
  };

  const mockEnvironments: Record<string, { id: string; path: string; mergeBaseBranch: string }> = {
    env_unconfirmed: { id: "env_unconfirmed", path: "/repos/unconfirmed-copy", mergeBaseBranch: "main" },
    env_valid: { id: "env_valid", path: "/repos/valid-copy", mergeBaseBranch: "main" },
  };

  const warnings: string[] = [];
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-server-resolver-"),
    settings: {
      workGraph: "strict",
      language: "ru",
    },
    sdk: {
      projects: {
        list: async () => [], // No projects have configured repo paths
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const t = mockThreads[threadId];
          if (!t) throw new Error(`thread ${threadId} not found`);
          return t;
        },
      },
    },
  });

  const origWarn = host.bb.log.warn.bind(host.bb.log);
  host.bb.log.warn = (msg: string, ...rest: unknown[]) => {
    warnings.push(msg);
    (origWarn as any)(msg, ...rest);
  };

  await createPlugin(host.bb, {
    bbCli: {
      run: async (args: string[]) => {
        if (args[0] === "environment" && args[1] === "show" && args[2]) {
          const env = mockEnvironments[args[2]];
          if (env) {
            return { exitCode: 0, stdout: JSON.stringify(env), stderr: "" };
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    cmd: mockCmdRunner,
  });

  const db = host.bb.storage.database();
  const store = new DelegationStore(db);

  // 1. Task with known target project but thread's projectId is null (unconfirmed environment)
  store.insertTask({
    taskKey: "TASK-NULL-THREAD-PROJ",
    projectId: "proj_target",
    coordinatorThreadId: "thr_null_proj",
    confirmationMode: "auto",
    route: "fix",
    level: "simple",
  });

  // 2. Task with known target project but missing/null coordinator_thread_id
  store.insertTask({
    taskKey: "TASK-NO-THREAD",
    projectId: "proj_target_no_thread",
    coordinatorThreadId: "",
    confirmationMode: "auto",
    route: "fix",
    level: "simple",
  });

  // 3. Task with valid matching project & thread environment
  store.insertTask({
    taskKey: "TASK-VALID-PROJ",
    projectId: "proj_valid",
    coordinatorThreadId: "thr_valid_proj",
    confirmationMode: "auto",
    route: "simple",
    level: "simple",
    payload: JSON.stringify({ acceptance_text: "Valid project task criteria" }),
  });

  // Call run-queue with a caller cwd pointing to a fake process dir
  const res = await host.harness.runCli(["run-queue", "--once"], { cwd: "/some/process/dir" });
  assert.equal(res.exitCode, 0);

  // Verification 1: Neither TASK-NULL-THREAD-PROJ nor TASK-NO-THREAD made git calls in /repos/unconfirmed-copy or /some/process/dir
  assert.ok(
    !gitCalls.some((c) => c.cwd === "/repos/unconfirmed-copy"),
    "Must not make git calls in unconfirmed environment /repos/unconfirmed-copy",
  );
  assert.ok(
    !gitCalls.some((c) => c.cwd === "/some/process/dir"),
    "Must not make git calls in process/caller cwd /some/process/dir",
  );
  assert.ok(
    !gitCalls.some((c) => c.args.some((a) => a.toLowerCase().includes("task-null-thread-proj"))),
    "TASK-NULL-THREAD-PROJ must make 0 git calls",
  );
  assert.ok(
    !gitCalls.some((c) => c.args.some((a) => a.toLowerCase().includes("task-no-thread"))),
    "TASK-NO-THREAD must make 0 git calls",
  );

  // Verification 2: Warnings logged for unconfirmed tasks
  assert.ok(
    warnings.some((w) => w.includes("TASK-NULL-THREAD-PROJ") && w.includes("proj_target")),
    "Warning logged for TASK-NULL-THREAD-PROJ indicating unconfirmed repo context",
  );
  assert.ok(
    warnings.some((w) => w.includes("TASK-NO-THREAD") && w.includes("proj_target_no_thread")),
    "Warning logged for TASK-NO-THREAD indicating unconfirmed repo context",
  );

  // Verification 3: TASK-VALID-PROJ progressed and ran in /repos/valid-copy
  const validCalls = gitCalls.filter((c) => c.cwd === "/repos/valid-copy");
  assert.ok(validCalls.length > 0, "TASK-VALID-PROJ must make git calls in /repos/valid-copy");
  assert.ok(
    validCalls.some((c) => c.args.some((a) => a.toLowerCase().includes("task-valid-proj"))),
    "Git calls for valid task must reference task-valid-proj",
  );
  assert.equal(store.getTask("TASK-VALID-PROJ")?.status, "running");
});

test("workgraph-mode helpers: normalizeWorkGraphMode, parseWorkGraphProjects, computeEffectiveWorkGraphMode, shouldShowApprovalMenu", () => {
  // Normalization
  assert.equal(normalizeWorkGraphMode(" STRICT "), "strict");
  assert.equal(normalizeWorkGraphMode(" SHADOW "), "shadow");
  assert.equal(normalizeWorkGraphMode(" OFF "), "off");
  assert.equal(normalizeWorkGraphMode("strict"), "strict");
  assert.equal(normalizeWorkGraphMode("invalid"), "off");
  assert.equal(normalizeWorkGraphMode(123), "off");
  assert.equal(normalizeWorkGraphMode(null), "off");
  assert.equal(normalizeWorkGraphMode(undefined), "off");

  // Project map parsing: trims keys and normalizes values, filters invalid entries
  const parsed = parseWorkGraphProjects(
    JSON.stringify({
      " proj_a ": " STRICT ",
      "proj_b": " shadow ",
      "proj_c": " OFF ",
      "proj_invalid": " not_a_mode ",
    }),
  );
  assert.deepEqual(parsed, {
    proj_a: "strict",
    proj_b: "shadow",
    proj_c: "off",
  });
  // Unrecognized value is filtered so it doesn't block inheritance
  assert.equal(parsed["proj_invalid"], undefined);

  // computeEffectiveWorkGraphMode: server > project override > global
  // 1. Server mode takes precedence
  assert.equal(
    computeEffectiveWorkGraphMode("strict", "off", "shadow"),
    "strict",
  );
  assert.equal(
    computeEffectiveWorkGraphMode(" OFF ", "strict", "shadow"),
    "off",
  );

  // 2. Project override takes precedence when server mode is null/empty
  assert.equal(
    computeEffectiveWorkGraphMode(null, " STRICT ", "off"),
    "strict",
  );
  assert.equal(
    computeEffectiveWorkGraphMode(undefined, "shadow", "off"),
    "shadow",
  );

  // 3. Fallback to global mode when server is null and project is invalid/null
  assert.equal(
    computeEffectiveWorkGraphMode(null, "invalid", " STRICT "),
    "strict",
  );
  assert.equal(
    computeEffectiveWorkGraphMode(null, null, "shadow"),
    "shadow",
  );
  assert.equal(
    computeEffectiveWorkGraphMode(null, null, null),
    "off",
  );

  // shouldShowApprovalMenu: only active for strict/shadow and orchestrator/executor
  assert.equal(shouldShowApprovalMenu("strict", "orchestrator"), true);
  assert.equal(shouldShowApprovalMenu("strict", "executor"), true);
  assert.equal(shouldShowApprovalMenu("shadow", "orchestrator"), true);
  assert.equal(shouldShowApprovalMenu("shadow", "executor"), true);

  assert.equal(shouldShowApprovalMenu("off", "orchestrator"), false);
  assert.equal(shouldShowApprovalMenu("off", "executor"), false);
  assert.equal(shouldShowApprovalMenu("strict", "auditor"), false);
  assert.equal(shouldShowApprovalMenu("strict", "researcher"), false);
  assert.equal(shouldShowApprovalMenu("strict", "architect"), false);
  assert.equal(shouldShowApprovalMenu("strict", "none"), false);
});

test("connected RPC: изоляция состояния при переключении открытых тредов", async () => {
  const host = createFakePluginHost({
    pluginId: "orchestrator",
    dataDir: makeTempDir("orch-thread-switch-"),
    settings: {
      workGraph: "off",
      workGraphProjects: JSON.stringify({
        " proj_1 ": " STRICT ",
        "proj_2": "shadow",
      }),
      language: "ru",
    },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "thr_1") return { projectId: "proj_1", status: "running" };
          if (threadId === "thr_2") return { projectId: "proj_2", status: "running" };
          if (threadId === "thr_3") return { projectId: null, status: "running" };
          throw new Error(`thread ${threadId} not found`);
        },
      },
    },
  });

  await createPlugin(host.bb, {
    bbCli: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
  });

  const db = host.bb.storage.database();
  const store = new DelegationStore(db);

  // Task in proj_1 associated with thr_1
  store.insertTask({
    taskKey: "TASK-PROJ-1",
    projectId: "proj_1",
    coordinatorThreadId: "thr_1",
    confirmationMode: "manual",
    route: "fix",
    level: "simple",
  });

  // 1. Thread 1 query: taskConfirmationMode finds TASK-PROJ-1 by threadId without client passing taskKey
  const res1 = (await host.harness.callRpc("taskConfirmationMode", {
    threadId: "thr_1",
  })) as { taskKey: string | null; mode: string | null; workGraph: string; projectId: string | null };
  assert.equal(res1.taskKey, "TASK-PROJ-1");
  assert.equal(res1.mode, "manual");
  assert.equal(res1.workGraph, "strict"); // from " proj_1 ": " STRICT "
  assert.equal(res1.projectId, "proj_1");

  // 2. User switches to Thread 2: query projectApprovalMode and taskConfirmationMode
  // Thread 2 has no task and belongs to proj_2 (shadow)
  const res2Proj = (await host.harness.callRpc("projectApprovalMode", {
    threadId: "thr_2",
  })) as { workGraph: string; projectId: string | null };
  assert.equal(res2Proj.workGraph, "shadow");
  assert.equal(res2Proj.projectId, "proj_2");

  const res2Task = (await host.harness.callRpc("taskConfirmationMode", {
    threadId: "thr_2",
  })) as { taskKey: string | null; mode: string | null; workGraph: string; projectId: string | null };
  assert.equal(res2Task.taskKey, null, "Thread 2 must NOT inherit taskKey from Thread 1");
  assert.equal(res2Task.mode, null);
  assert.equal(res2Task.workGraph, "shadow");
  assert.equal(res2Task.projectId, "proj_2", "Thread 2 must NOT inherit projectId from Thread 1");

  // 3. Thread 3 with null projectId falls back to global off
  const res3Proj = (await host.harness.callRpc("projectApprovalMode", {
    threadId: "thr_3",
  })) as { workGraph: string; projectId: string | null };
  assert.equal(res3Proj.workGraph, "off", "Thread 3 with null project falls back to global off");
});
