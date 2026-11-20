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

test("3-step order of task project resolution: 1. task_queue -> 2. delegations -> 3. tracker", () => {
  const store = createTestStore();
  const t0 = 1_000_000;

  // Step 3 alone: only tracker has the project
  const trackerOnly = {
    getTask: (k: string) => (k === "TASK-3" ? { projectId: "proj_from_tracker" } : null),
  };
  assert.equal(resolveTaskProjectId(store, "TASK-3", trackerOnly), "proj_from_tracker");

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
  assert.equal(resolveTaskProjectId(store, "TASK-2", trackerOverride), "proj_from_delegation");

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
  assert.equal(resolveTaskProjectId(store, "TASK-1", trackerOverride), "proj_from_queue");
});

test("1) Тест изоляции strict и off: Проект A в strict, Проект B в off", () => {
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
  assert.doesNotThrow(() => {
    assertGraphAllowsDirectAction(store, "TASK-B", "off", {
      command: "delegate",
      projectsMap,
      tracker,
    });
  });

  // Direct action on Task A (project A is in strict, task not enqueued): blocked with graph-required
  assert.throws(
    () => {
      assertGraphAllowsDirectAction(store, "TASK-A", "off", {
        command: "delegate",
        projectsMap,
        tracker,
      });
    },
    (e: any) => e.code === "graph-required",
  );
});

test("2) Тест тишины наблюдателя при off: прямой вызов оставляет task_transitions пустым", () => {
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
  assertGraphAllowsDirectAction(store, "TASK-B", "shadow", {
    command: "delegate",
    projectsMap,
    tracker,
  });
  assertGraphAllowsDirectAction(store, "TASK-B", "shadow", {
    command: "merge",
    projectsMap,
    tracker,
  });
  assertGraphAllowsDirectAction(store, "TASK-B", "shadow", {
    command: "release",
    projectsMap,
    tracker,
  });

  // Absolutely no transitions written for TASK-B
  const transitionsB = store.listTransitions("TASK-B");
  assert.equal(transitionsB.length, 0);

  // In contrast, Task A in shadow mode does record a mirror transition
  assertGraphAllowsDirectAction(store, "TASK-A", "shadow", {
    command: "delegate",
    projectsMap,
    tracker,
  });
  const transitionsA = store.listTransitions("TASK-A");
  assert.equal(transitionsA.length, 1);
  assert.equal(transitionsA[0].reason, "task-not-enqueued");
});

test("3) Тест неопределённого проекта: задача берёт глобальный workGraph и логирует предупреждение", () => {
  const store = createTestStore();
  const warnings: string[] = [];
  const log = {
    warn: (msg: string) => {
      warnings.push(msg);
    },
  };

  // Undetermined task with global mode strict -> blocks with graph-required and logs warning
  assert.throws(
    () => {
      assertGraphAllowsDirectAction(store, "UNDETERMINED-1", "strict", {
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
  assert.doesNotThrow(() => {
    assertGraphAllowsDirectAction(store, "UNDETERMINED-2", "off", {
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

test("4) Тест наследования от глобального режима при отсутствии явного переопределения проекта", () => {
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
  assert.throws(
    () => {
      assertGraphAllowsDirectAction(store, "TASK-C", "strict", {
        command: "delegate",
        projectsMap,
        tracker,
      });
    },
    (e: any) => e.code === "graph-required",
  );

  // With global mode off, Task C inherits off -> succeeds without error
  assert.doesNotThrow(() => {
    assertGraphAllowsDirectAction(store, "TASK-C", "off", {
      command: "delegate",
      projectsMap,
      tracker,
    });
  });
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
