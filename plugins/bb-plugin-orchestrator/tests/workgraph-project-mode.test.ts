import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DelegationStore, MIGRATIONS } from "../src/store.js";
import {
  parseWorkGraphProjects,
  resolveWorkGraphMode,
  resolveTaskProjectId,
  assertGraphAllowsDirectAction,
  runRunQueue,
  runEnqueue,
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
          task: { projectId: "proj_bbcli" },
          project: { linkedBbProjectId: "proj_linked", id: "proj_id" },
        }),
        stderr: "",
      };
    },
  };
  assert.equal(
    await resolveTaskProjectId(store, "CLI-1", { bbCli: fakeBbCli }),
    "proj_bbcli",
  );

  // C. Unified field priority: task.projectId ?? task.project?.linkedBbProjectId ?? task.project?.id
  // 1) task.projectId wins over linkedBbProjectId and id
  const trackerPrio1 = {
    getTask: () => ({
      task: { projectId: "p1" },
      project: { linkedBbProjectId: "p2", id: "p3" },
    }),
  };
  assert.equal(await resolveTaskProjectId(store, "PRIO-1", trackerPrio1), "p1");

  // 2) linkedBbProjectId wins over id when task.projectId is absent
  const trackerPrio2 = {
    getTask: () => ({
      task: {},
      project: { linkedBbProjectId: "p2", id: "p3" },
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
      task: { projectId: "proj_tracker_target" },
      project: { linkedBbProjectId: "proj_tracker_target" },
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
