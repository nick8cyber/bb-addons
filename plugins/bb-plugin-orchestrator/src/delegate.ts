/**
 * `delegate` — one call instead of dispatch → thread update → options mode
 * (spec §4). Steps:
 *   1. policy/level/route/limits checks;
 *   2. INSERT the delegation as `dispatching` (the partial unique index is
 *      the double-dispatch guard);
 *   3. own spawn (§4 r30): `bb tasks show` + `bb tasks preset show` → the
 *      BB seed prompt → `threads.spawn` with the parent, `hidden`,
 *      `parentNotifications=auto` and `pluginMetadata.delegationId` set at
 *      creation → record `thread_id` at once. `bb tasks dispatch` stays
 *      the fallback for a spawn schema refusal on the parent/visibility
 *      fields only (r30 е 3);
 *   4. attach: `bb tasks attach` + conditional `in_progress` (r30 г),
 *      then a binding VERIFY — read the thread, update only on mismatch;
 *   5. best-effort `mode=bypass` for `permissionMode=full` presets;
 *   6. status `running` + task comment «Раздано: …»;
 *   7. return the delegation.
 * Steps 4–6 errors land in `setup_errors`; the delegation stays `running`
 * and the reconcile stage (later) retries them.
 */
import { OrchestratorError } from "./errors.js";
import {
  mergeDispatchInstructions,
  reviewRoundLine,
  roundSection,
} from "./instructions.js";
import {
  BUILTIN_UNAVAILABLE_PATTERNS,
  DEFAULT_ROUTE_BUSY_WAIT_SECONDS,
  canonicalPresetName,
  canonicalQuotaGroup,
  canonicalRouteName,
  findRoute,
  pickRoute,
  quotaGroupOf,
  quotaGroupsForOneOff,
  resolvePolicyRoute,
  routeNameChain,
  type Policy,
  type PolicyLoad,
  type PolicyRoute,
} from "./policy.js";
import {
  normalizeTaskKey,
  type DelegationRow,
  type DelegationStore,
} from "./store.js";
import type { ResolvedProject } from "./release-config.js";
import {
  isCoordinator,
  isR33NewThread,
  type ExecutorProbes,
  type ThreadFacts,
} from "./agent-config.js";
import { NO_ROLE, roleForLevel } from "./roles.js";
import { delegateBase } from "./delegate-base.js";
import {
  presetModelMap,
  runChecked,
  runJson,
  type BbCli,
} from "./bb-cli.js";
import type { CmdRunner } from "./cmd.js";
import { T_RU, type T } from "./i18n/index.js";
import {
  verifySpecBeforeCodeGate,
  resolveExecutorBaseSha,
  resolvePresetBaseBranch,
  resolveTaskSpecContract,
  type SpecContract,
} from "./spec-gate.js";
import type { WorkGraphMode } from "./workgraph.js";

export interface SetupError {
  step: string;
  message: string;
}

export interface DelegateParams {
  taskKey: string;
  level: string;
  route?: string;
  /** §2.3: a one-off existing preset, dispatched outside the policy
   * routes. Mutually exclusive with `route`. */
  preset?: string;
  instructions?: string;
  /** §6 `--from`: continue this round from an explicit sha/branch. */
  from?: string;
  /** §6 `--fresh`: no continuation — the round starts from the base. */
  fresh?: boolean;
  /** §4.1 r28: mark the delegation «задача без кода» (no commits expected). */
  noCode?: boolean;
  /** §20.1 п.4 (r34.4): `--attach` — repo-relative paths of the task's
   * key files; the path list rides in the seed prompt and the task
   * instructions, the files' bytes are never inlined. */
  attach?: string[];
  caller: ThreadFacts;
  specBeforeCode?: boolean;
}

export interface DelegateResult {
  ok: true;
  delegationId: number;
  taskKey: string;
  threadId: string | null;
  level: string;
  route: string;
  /** §2.3 reviewByLevel note, e.g. «review → review-medium по сложности
   * исполнения medium». */
  note?: string;
  /** `cancelled` when the delegation was cancelled while dispatch ran;
   * `queued` — parked behind a busy `maxActive` route (§20.1 п.5). */
  status: "running" | "cancelled" | "queued";
  setupErrors: SetupError[];
  /** §22.2: «база не проверена: <причина>» when the published-base
   * check did not run for this dispatch. */
  baseUnchecked?: string;
  /** §20.1 п.5: routes skipped in this dispatch («пропущен X: причина»). */
  skipped?: { route: string; reason: string }[];
}

interface DispatchResponse {
  threadId?: string;
  task?: { id?: string };
}

/** `bb tasks show --json` — the fields the own-spawn path consumes (r30 а). */
export interface TaskShowResponse {
  task?: {
    id?: string;
    key?: string;
    title?: string;
    description?: string;
    status?: string;
  };
  project?: { name?: string; linkedBbProjectId?: string | null };
  subtasks?: { key?: string; title?: string; status?: string }[];
  attachments?: { fileName?: string; id?: string }[];
  comments?: {
    authorName?: string;
    kind?: string;
    createdAt?: string;
    body?: string;
  }[];
}

/** `bb tasks preset show --json` — the fields spawn needs (r30 а). */
export interface PresetShowResponse {
  preset?: {
    providerId?: string;
    modelId?: string | null;
    reasoningLevel?: string | null;
    serviceTier?: string | null;
    permissionMode?: string;
    environmentKind?: string;
    baseBranch?: string | null;
    machineId?: string | null;
    instructions?: string;
  };
}

/** `threads.spawn` args for the own-spawn dispatch (r30 в). The SDK 0.4.87
 * types lack `parentNotifications` — the 0.49 server accepts it, so the
 * call site casts; declared here so fakes stay honest. */
export interface SpawnThreadArgs {
  projectId: string;
  environment: unknown;
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  serviceTier?: string;
  permissionMode?: string;
  title?: string;
  prompt: string;
  parentThreadId?: string;
  parentNotifications?: string;
  visibility?: "hidden" | "visible";
  pluginMetadata?: Record<string, unknown>;
}

/** The `threads.list` row shape the label lookup reads (r30 е 4). */
export interface ListedThreadSummary {
  id: string;
  title?: string | null;
  titleFallback?: string | null;
  createdAt?: number | null;
}

/** The `bb.sdk.threads` surface the dispatch steps use. */
export interface DelegateThreads {
  /** §4 r30: the own executor spawn — returns the created thread. */
  spawn(args: SpawnThreadArgs): Promise<{ id?: string }>;
  /** §4 r30 (е 4): children of the coordinator for the label lookup. */
  list(args: {
    parentThreadId?: string;
    includeHidden?: boolean;
    limit?: number;
  }): Promise<ListedThreadSummary[]>;
  /** §4 r30 (е 4): the `pluginMetadata.delegationId` label — absent from
   * the list DTO, so it is a per-candidate read. Optional: without it the
   * lookup degrades to the title+createdAt filter. */
  getPluginMetadata?(args: {
    threadId: string;
  }): Promise<Record<string, unknown> | null | undefined>;
  update(args: {
    threadId: string;
    parentThreadId?: string | null;
    visibility?: "hidden" | "visible";
  }): Promise<unknown>;
  stop(args: { threadId: string }): Promise<unknown>;
  /** §13.2 п.4 display metadata; absent in tests that do not fake it. */
  updatePluginMetadata?(args: {
    threadId: string;
    set: { role: string };
  }): Promise<unknown>;
}

export interface DelegateDeps {
  store: DelegationStore;
  bbCli: BbCli;
  /** `bb.sdk.threads` — `spawn` creates the executor, `update`/`stop` are
   * the binding repair and the cancelled-during-dispatch cleanup. */
  threads: DelegateThreads;
  loadPolicy(): Promise<PolicyLoad>;
  probes: ExecutorProbes;
  /** §4 r30 (в): `system.config().primaryHostId` for `new-worktree`
   * presets without an explicit `machineId`. */
  primaryHostId(): Promise<string>;
  dispatchTimeoutMs?: number;
  /** §17.3: git access for the continue-point ancestry check — without
   * it `continuePoint` falls back to the timestamp heuristic. */
  cmd?: CmdRunner;
  /** §22.2: this machine's bb hostId — the published-base check runs
   * only for a worktree on THIS host. */
  localHostId?: () => string | Promise<string>;
  /** §22.1: refresh the repo's `orchestrator-leaks.json` snapshot on
   * delegation — the executor's worktree scans staged diffs against
   * these rules from its first commit. Best-effort. */
  leaksSnapshot?: (repo: string, projectId: string) => void | Promise<void>;
  /** §2.2 git rules, read fresh at dispatch so edits and reissues see the
   * current setting (the server resolves built-in values to `language`). */
  gitInstructions?: () => string | undefined;
  /** §20.2 (r33): clock override for tests. */
  now?: () => number;
  /** §2.3 r24: parsed policy for the level→role map; absent = name rule. */
  policy?: () => Policy | null;
  /** routes the policy load marked unavailable. */
  unavailableRoutes?: () => ReadonlySet<string>;
  /** §18.1: human-facing texts — the language catalog. */
  t?: T;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
  workGraphMode?: WorkGraphMode | ((projectId?: string) => WorkGraphMode);
  repoRoot?: string;
  resolveRepoRoot?: (row: DelegationRow) => Promise<string | undefined>;
  project?: ResolvedProject | null;
  resolveProject?: (
    projectId: string,
  ) => Promise<ResolvedProject | null> | ResolvedProject | null;
}

/**
 * Narrower deps for the post-insert steps: dispatch (§4.3), attach,
 * notifications, bypass, finalize, comment (§4.4–4.7). The watchdog's
 * reissue (§5.4) and reconcile (§7) call these without the §4.1–4.2 checks,
 * so later changes to the steps cover reissued threads too.
 */
export interface DispatchStepsDeps {
  store: DelegationStore;
  bbCli: BbCli;
  threads: DelegateDeps["threads"];
  /** §4 r30 (в): `system.config().primaryHostId` for `new-worktree`
   * presets without an explicit `machineId`. */
  primaryHostId(): Promise<string>;
  dispatchTimeoutMs?: number;
  /** §22.2: git access for the published-base check (fetch +
   * origin/<base>); absent — the preset's base passes unchanged. */
  cmd?: CmdRunner;
  /** §22.2: this machine's bb hostId — the published-base check runs
   * only for a worktree on THIS host. */
  localHostId?: () => string | Promise<string>;
  leaksSnapshot?: DelegateDeps["leaksSnapshot"];
  gitInstructions?: DelegateDeps["gitInstructions"];
  now?: () => number;
  /** §2.3 r24: parsed policy for the level→role map; absent = name rule. */
  policy?: () => Policy | null;
  /** routes the policy load marked unavailable — the skip/advance
   * step needs the same filter as `pickRoute`. */
  unavailableRoutes?: () => ReadonlySet<string>;
  t?: T;
  workGraphMode?: WorkGraphMode | ((projectId?: string) => WorkGraphMode);
  repoRoot?: string;
  resolveRepoRoot?: (row: DelegationRow) => Promise<string | undefined>;
  project?: ResolvedProject | null;
  resolveProject?: (
    projectId: string,
  ) => Promise<ResolvedProject | null> | ResolvedProject | null;
}

export interface DispatchStepsResult {
  threadId: string | null;
  /** `cancelled` when the delegation was cancelled while dispatch ran;
   * `queued` — parked behind a busy `maxActive` route (§20.1 п.5). */
  status: "running" | "cancelled" | "queued";
  setupErrors: SetupError[];
  /** §22.2: the published-base check did not run — the localized
   * «база не проверена: <причина>» line for the delegate response. */
  baseUnchecked?: string;
  /** §20.1 п.5: routes skipped in this dispatch («пропущен X: причина»). */
  skipped?: { route: string; reason: string }[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export { canonicalPresetName };

/** §20.1 п.4: the `attach` column's JSON spec — the `--attach` path
 * list and the explicit `--from` ref, inherited by reissues. */
interface AttachSpec {
  paths: string[];
  from: string | null;
}

const EMPTY_SPEC: AttachSpec = { paths: [], from: null };

function parseAttachSpec(attach: string | null | undefined): AttachSpec {
  if (!attach) return EMPTY_SPEC;
  try {
    const parsed = JSON.parse(attach) as {
      paths?: unknown;
      from?: unknown;
    };
    return {
      paths: Array.isArray(parsed?.paths)
        ? parsed.paths.filter((p): p is string => typeof p === "string")
        : [],
      from: typeof parsed?.from === "string" ? parsed.from : null,
    };
  } catch {
    return EMPTY_SPEC;
  }
}

/** orchestrator-release §2 r10 п.4: the release-auditor thread is
 * parent-muted BY CONTRACT — `off` is its expected mode, `auto` every
 * other delegation's. */
export const RELEASE_AUDIT_LEVEL = "release-audit";
export const expectedParentNotify = (level: string): "off" | "auto" =>
  level === RELEASE_AUDIT_LEVEL ? "off" : "auto";

/** bb task keys look like `PLUG-129`; anything else is resolved as a ULID. */
const TASK_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;

export async function runDelegate(
  params: DelegateParams,
  deps: DelegateDeps,
): Promise<DelegateResult> {
  const t = deps.t ?? T_RU;
  const { store, bbCli } = deps;

  // Caller gate (§4): only a coordinator may delegate, even from a CLI shell
  // running inside an executor thread. §19.3: a thread with the explicit
  // `none` role — or a NEW thread the r33 hook saw but could not assign —
  // gets the stable `no-role` code instead of `not-a-coordinator`.
  if (!isCoordinator(params.caller, deps.probes)) {
    const recorded = deps.probes.roleByThreadId?.(params.caller.threadId);
    if (
      recorded === NO_ROLE ||
      (recorded === undefined &&
        isR33NewThread(params.caller, deps.probes))
    ) {
      throw new OrchestratorError(
        "no-role",
        `thread ${params.caller.threadId} has no orchestrator role`,
        "a role is assigned on the thread's first message — or pick one in the new-chat window",
      );
    }
    throw new OrchestratorError(
      "not-a-coordinator",
      t("del.notCoordinator", { threadId: params.caller.threadId }),
      t("del.notCoordinatorHint"),
    );
  }

  // §4 input: a task ULID resolves to its key before every check, so the
  // dedup index works on one canonical form.
  let taskKey = params.taskKey.trim();
  if (!TASK_KEY_RE.test(taskKey)) {
    const shown = await runJson<{ task?: { key?: string; id?: string } }>(
      bbCli,
      ["tasks", "show", taskKey, "--json"],
    ).catch((e) => {
      throw new OrchestratorError(
        "task-not-found",
        t("del.taskNotFound", { input: params.taskKey, error: message(e) }),
      );
    });
    if (!shown.task?.key) {
      throw new OrchestratorError(
        "task-not-found",
        t("del.taskNoKey", { input: params.taskKey }),
      );
    }
    taskKey = shown.task.key;
  }
  taskKey = taskKey.toUpperCase();

  const load = await deps.loadPolicy();
  const policy = load.policy;
  if (!policy) {
    const first = load.errors[0];
    throw new OrchestratorError(
      "policy-invalid",
      t("del.policyInvalid", {
        detail: first ? `${first.path}: ${first.message}` : "empty",
      }),
      t("del.policyInvalidHint"),
    );
  }

  // §2.3: --route and --preset pick different kinds of destinations —
  // together the call is ambiguous.
  if (params.route && params.preset) {
    throw new OrchestratorError(
      "incompatible-flags",
      t("del.routePresetConflict"),
      t("del.routePresetHint"),
    );
  }

  // §2.3 reviewByLevel: bare `--level review` resolves to the auditor
  // level mapped from the latest executor delegation's complexity —
  // explicit levels, --route and --preset keep the caller's choice.
  let level = params.level;
  let levelNote: string | undefined;
  if (
    level === "review" &&
    policy.reviewByLevel &&
    !params.route &&
    !params.preset
  ) {
    // §2.3 (PLUG-182): the LATEST executor-role delegation decides —
    // mapped or not; a level missing from the map falls back to `review`.
    const latestExec = store
      .delegationsByTask(taskKey)
      .find((r) => roleForLevel(r.level, policy) === "executor");
    if (latestExec) {
      const mapped = policy.reviewByLevel[latestExec.level] ?? "review";
      if (mapped !== "review") {
        levelNote = t("del.levelNote", {
          mapped,
          level: latestExec.level,
        });
      }
      level = mapped;
    }
  }

  // §17.3 (мелко 3): the release pipeline alone assigns `release-audit`
  // — a coordinator must not mint a release auditor by hand.
  if (level === "release-audit") {
    throw new OrchestratorError(
      "level-forbidden",
      t("del.levelForbidden"),
      t("del.levelForbiddenHint"),
    );
  }

  // §6: `--from` picks the continuation point, `--fresh` drops it — never
  // both; the silent precedence hid caller mistakes (PLUG-176). The check
  // precedes the limits so a mis-flagged call fails on its own error even
  // when the task is already at the cap.
  if (params.from && params.fresh) {
    throw new OrchestratorError(
      "incompatible-flags",
      t("del.fromFreshConflict"),
      t("del.fromFreshHint"),
    );
  }

  // §20.1 п.4: `--attach` paths are repo-relative — no absolute paths,
  // no `..`, no NUL.
  for (const path of params.attach ?? []) {
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("..") ||
      path.includes("\u0000") ||
      path.endsWith("/")
    ) {
      throw new OrchestratorError(
        "invalid-arguments",
        `attach-invalid: ${path}`,
      );
    }
  }

  const held = store.heldGroups(Date.now());
  const role = roleForLevel(level, policy);
  const taskRow = store.getTask?.(taskKey);
  let routeName: string;
  let route: PolicyRoute;
  let reviewerWarning: string | undefined;
  if (params.preset) {
    // §17.3 (мелко 3): even outside the policy routes the LEVEL still
    // comes from the policy — an undeclared level is a refusal, as
    // `pickRoute` already enforces for --route and chain picks.
    if (!policy.levels[level]) {
      throw new OrchestratorError(
        "unknown-level",
        t("del.unknownLevel", { level }),
        t("del.unknownLevelHint", {
          levels: Object.keys(policy.levels).join(", "),
        }),
      );
    }
    // §2.3: a one-off preset dispatches outside the policy routes —
    // provider and model come from the preset itself, and its quota is
    // shared with every policy route on the same provider AND model
    // (PLUG-182), so a burned preset closes only those.
    const show = await runJson<{
      preset?: { providerId?: string; modelId?: string | null };
    }>(
      bbCli,
      ["tasks", "preset", "show", params.preset, "--json"],
    ).catch((e) => {
      throw new OrchestratorError(
        "unknown-preset",
        t("del.unknownPreset", { preset: params.preset!, error: message(e) }),
      );
    });
    const provider = show.preset?.providerId;
    if (!provider) {
      throw new OrchestratorError(
        "unknown-preset",
        t("del.presetNoProvider", { preset: params.preset! }),
      );
    }
    routeName = `preset:${params.preset}`;
    const presetModels = await presetModelMap(bbCli);
    const groups = quotaGroupsForOneOff(
      policy,
      {
        route: routeName,
        provider,
        modelId: show.preset?.modelId ?? presetModels.get(params.preset),
      },
      presetModels,
    );
    const canonHeld = new Set(
      [...held].map((h) => canonicalQuotaGroup(h, policy)),
    );
    const blocked = groups.find(
      (g) => held.has(g) || canonHeld.has(canonicalQuotaGroup(g, policy)),
    );
    if (blocked) {
      throw new OrchestratorError(
        "route-held",
        t("del.routeHeld", { group: blocked }),
        t("del.routeHeldHint"),
      );
    }
    route = { preset: params.preset, provider };
  } else {
    // §34.1 / §34.6: reviewer ≠ executor applies to auditors and architects on design_check
    const isReview =
      role === "auditor" ||
      (role === "architect" && taskRow?.node === "design_check");
    let lastExecRoute: string | undefined;
    let lastExecProvider: string | undefined;
    let lastExecModel: string | undefined;
    if (isReview) {
      const pastExec = store
        .delegationsByTask(taskKey)
        .filter(
          (r) => roleForLevel(r.level, policy) === "executor" && r.status === "done",
        )
        .at(-1);
      if (pastExec) {
        lastExecRoute = pastExec.route;
        lastExecProvider = pastExec.provider;
        lastExecModel = policy.routes[pastExec.route]?.model;
      }
      if (taskRow?.payload) {
        try {
          const p = JSON.parse(taskRow.payload);
          if (taskRow.node === "spec_review") {
            // For spec_review, take into account both the spec executor and the design architect
            lastExecRoute = p.last_executor_route ?? p.design_architect_route ?? lastExecRoute;
            lastExecProvider = p.last_executor_provider ?? p.design_architect_provider ?? lastExecProvider;
            lastExecModel = p.last_executor_model ?? p.design_architect_model ?? lastExecModel;
          } else {
            if (p.last_executor_route) lastExecRoute = p.last_executor_route;
            if (p.last_executor_provider) lastExecProvider = p.last_executor_provider;
            if (p.last_executor_model) lastExecModel = p.last_executor_model;
          }
          if (lastExecRoute && !lastExecModel && policy.routes[lastExecRoute]?.model) {
            lastExecModel = policy.routes[lastExecRoute]?.model;
          }
        } catch {}
      }
    }
    const picked = pickRoute(policy, level, {
      requested: params.route,
      unavailableRoutes: new Set(load.unavailableRoutes),
      heldGroups: held,
      skipSameModelAsExecutor: isReview,
      lastExecutorRoute: lastExecRoute,
      lastExecutorProvider: lastExecProvider,
      lastExecutorModel: lastExecModel,
    });
    routeName = picked.name;
    route = picked.route;
    reviewerWarning = picked.warning;
    if (picked.warning) {
      if (deps.log?.warn) {
        deps.log.warn(`[orchestrator] ${picked.warning}`);
      } else {
        console.warn(`[orchestrator] ${picked.warning}`);
      }
    }
  }

  // Limits (§4 step 1) — over the limit is a refusal, not a queue (§10).
  // §19.1 (r33): helpers occupy the same `limits.maxActive` pool —
  // active helpers count together with delegations.
  const maxActive = policy.limits?.maxActive;
  if (maxActive !== undefined) {
    const count = store.activeCount() + store.helperActiveCount();
    if (count >= maxActive) {
      throw new OrchestratorError(
        "limit-exceeded",
        t("del.limitActive", { count, max: maxActive }),
        t("del.limitActiveHint"),
      );
    }
  }
  const perLevel = policy.limits?.perLevel?.[level];
  if (perLevel !== undefined) {
    const count = store.activeCountByLevel(level);
    if (count >= perLevel) {
      throw new OrchestratorError(
        "limit-exceeded",
        t("del.limitLevel", { level: params.level, count, max: perLevel }),
      );
    }
  }

  // §4.1 rounds: every delegate is a new round — §17.2 (e2e 2): counted
  // by EXECUTOR-role delegations only, so review and release-audit rounds
  // no longer shift the «Заход N» number the coordinator sees. The round
  // continues from `--from`, else from the task's continue point — the
  // previous round's result SHA, or the newer `published_sha` a release
  // left (§17.3 С4: the repeat release fast-forwards the same remote
  // branch); `--fresh` disables continuation.
  const round =
    Math.max(
      0,
      ...store
        .delegationsByTask(taskKey)
        .filter((r) => roleForLevel(r.level, policy) === "executor")
        .map((r) => r.round),
    ) + 1;
  const continueFrom = params.fresh
    ? null
    : (params.from ??
      (await store.continuePoint(
        taskKey,
        // no git access (tests, odd embedders) → the timestamp heuristic
        deps.cmd
          ? async (repoPath, a, b) => {
              const r = await deps.cmd!.run(
                "git",
                ["-C", repoPath, "merge-base", "--is-ancestor", a, b],
                { timeoutMs: 30_000 },
              );
              return r.exitCode === 0;
            }
          : undefined,
      )) ?? null);

  // §34.6 (ADR-0037): Read-only environment on design and design_check for architect
  const isArchitectNode =
    role === "architect" ||
    taskRow?.node === "design" ||
    taskRow?.node === "design_check";
  const isVerificationRole =
    role === "auditor" ||
    role === "architect" ||
    role === "researcher";
  const effectiveNoCode = isArchitectNode || isVerificationRole ? true : (params.noCode ?? false);

  // §31.9: Prevent direct delegation while waiting at owner_gate
  if (role === "executor" && !effectiveNoCode && (taskRow?.status === "waiting_approval" || taskRow?.node === "owner_gate")) {
    throw new OrchestratorError(
      "spec-gate-violation",
      `spec-gate-violation: задача ${taskKey} ожидает одобрения владельца (owner_gate); запуск кода до решения владельца запрещён`,
    );
  }

  let executorBaseSha: string | undefined;

  // §31.9 (ADR-0032): spec-before-code gate before creating delegation row
  if (role === "executor" && !effectiveNoCode) {
    const mode =
      typeof deps.workGraphMode === "function"
        ? (deps.workGraphMode as any)(params.caller.projectId)
        : deps.workGraphMode;
    const isGateActive =
      (mode === "strict" || mode === "shadow" || Boolean(policy.specBeforeCode)) &&
      Boolean(deps.cmd && deps.repoRoot);
    if (isGateActive) {
      const effectiveProj = params.caller.projectId ?? taskRow?.project_id;
      const proj = effectiveProj && deps.resolveProject
        ? await Promise.resolve(deps.resolveProject(effectiveProj)).catch(() => null)
        : (deps.project ?? null);
      const presetName = params.preset ?? route.preset;
      const presetBaseBranch = await resolvePresetBaseBranch(presetName, {
        policy,
        presetDetails: (policy as any)?.presetDetails,
      });
      if (deps.cmd && deps.repoRoot) {
        try {
          executorBaseSha = await resolveExecutorBaseSha({
            cmd: deps.cmd,
            repoRoot: deps.repoRoot,
            from: params.from,
            baseBranch: presetBaseBranch ?? (proj as any)?.baseBranch ?? (policy as any)?.baseBranch,
          });
        } catch {}
      }
      await verifySpecBeforeCodeGate({
        taskKey,
        role,
        noCode: effectiveNoCode,
        level,
        store,
        cmd: deps.cmd,
        policy,
        project: proj,
        baseSha: executorBaseSha,
        preparedBaseSha: params.from,
        baseBranchName: presetBaseBranch,
        presetName,
        workGraphMode: mode,
        specBeforeCode: policy.specBeforeCode,
        repoRoot: deps.repoRoot,
        task: taskRow ?? undefined,
      });
    }
  }

  // Step 2 — the unique index makes this atomic across processes.
  let row;
  try {
    row = store.insert({
      taskKey,
      projectId: params.caller.projectId,
      coordinatorThreadId: params.caller.threadId,
      level,
      route: routeName,
      preset: route.preset,
      provider: route.provider,
      round,
      continueFrom: continueFrom,
      explicitRoute: params.route !== undefined || params.preset !== undefined,
      noCode: effectiveNoCode,
      // §20.1 п.4: the attach spec survives onto the row — a reissue
      // lists the same `--attach` paths in the seed prompt.
      attach:
        params.attach?.length || params.from
          ? JSON.stringify({
              paths: params.attach ?? [],
              from: params.from ?? null,
            })
          : null,
    });
  } catch (e) {
    if (
      (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
      /UNIQUE constraint/.test(message(e))
    ) {
      throw new OrchestratorError(
        "task-already-delegated",
        t("del.taskDelegated", { taskKey }),
        t("del.taskDelegatedHint"),
      );
    }
    throw e;
  }

  let instructions = reviewerWarning
    ? (params.instructions
        ? `${reviewerWarning}\n\n${params.instructions}`
        : reviewerWarning)
    : params.instructions;
  // §34.6: Attach standardized design_check packet if present in task payload
  if (taskRow?.node === "design_check" && taskRow?.payload) {
    try {
      const pl = JSON.parse(taskRow.payload);
      if (typeof pl.design_check_packet === "string" && pl.design_check_packet) {
        instructions = instructions
          ? `${instructions}\n\n${pl.design_check_packet}`
          : pl.design_check_packet;
      }
    } catch {}
  }

  // Steps 3–7 — shared with the watchdog's reissue (§5.4): the same
  // function dispatches, attaches, finalizes and reports.
  let res: DispatchStepsResult;
  try {
    res = await dispatchToRoute(
      row,
      {
        instructions,
        levelNote,
        // §17.2 (PLUG-211 С4): a manual delegate owns the refusal comment.
        commentOnRefusal: true,
        from: params.from,
        specBeforeCode: params.specBeforeCode,
        immutableBaseSha: executorBaseSha,
      },
      {
        ...deps,
        policy: () => policy,
        unavailableRoutes: load.unavailableRoutes?.length
          ? () => new Set(load.unavailableRoutes)
          : deps.unavailableRoutes,
      },
    );
  } catch (e) {
    // §5.3 rev 19: a synchronous refusal naming a removed model puts the
    // ROUTE on hold so the next dispatch skips it (the reissue path holds
    // and continues the chain from the watchdog).
    if ((e as { code?: string }).code === "dispatch-failed") {
      const patterns = [
        ...BUILTIN_UNAVAILABLE_PATTERNS,
        ...(route.unavailablePatterns ?? []),
      ];
      const text = message(e);
      if (patterns.some((p) => text.toLowerCase().includes(p.toLowerCase()))) {
        store.hold(
          routeName,
          Date.now() + 15 * 60 * 1000,
          t("del.holdReason", { text: text.slice(0, 180) }),
        );
        throw new OrchestratorError(
          "dispatch-failed",
          t("del.routeHeldNote", { text, route: routeName }),
          e instanceof OrchestratorError ? e.hint : undefined,
        );
      }
    }
    throw e;
  }

  return {
    ok: true,
    delegationId: row.id,
    taskKey: row.task_key,
    threadId: res.threadId,
    level,
    route: res.status === "queued" ? row.route : routeName,
    note:
      [
        levelNote,
        ...(res.skipped ?? []).map((s) =>
          t("del.routeSkipped", { route: s.route, reason: s.reason }),
        ),
        res.status === "queued"
          ? t("del.routeBusy", { route: row.route })
          : undefined,
      ]
        .filter(Boolean)
        .join("\n") || undefined,
    status: res.status,
    setupErrors: res.setupErrors,
    baseUnchecked: res.baseUnchecked,
  };
}

/**
 * §4 step 3 + steps 4–7 on an existing `dispatching` row: `bb tasks
 * dispatch`, record `thread_id`, attach, notifications, bypass, `running`,
 * «Раздано» comment. Also the reissue path (§5.4): the watchdog inserts the
 * `dispatching` row itself and calls this — no copied dispatch logic.
 *
 * An explicit dispatch failure deletes the row; a timeout or unreadable
 * answer leaves it `dispatching` without `thread_id` for the §7 reconcile
 * and throws `dispatch-unknown`.
 */
interface DispatchOpts {
  instructions?: string;
  /** §2.3 reviewByLevel: replaces «уровень X» in the «Раздано» comment. */
  levelNote?: string;
  /**
   * What an explicit dispatch refusal does to the record. Default
   * `remove` (§4 step 3); `fail` marks it `failed` instead — the §7
   * reconcile uses it for `reissue_of` rows, which must never silently
   * vanish (§5.4 rev 13).
   */
  onDispatchFailure?: "remove" | "fail";
  /**
   * §17.2 (e2e 6 + PLUG-211 С4): write the dispatch refusal to the
   * task — only for CALLER-INITIATED dispatches (manual delegate,
   * release audit). The watchdog's reissue path reports the refusal
   * through `report`, which already comments the task; both would
   * double the reason in the task trail.
   */
  commentOnRefusal?: boolean;
  /** §22.2: the caller's explicit `--from` (not the continue point it
   * resolved to) — a LOCAL target branch with unpublished commits
   * refuses `from-unpublished` before the spawn. */
  from?: string;
  /** §20.1 п.5: the «маршрут занят» gate — evaluated INSIDE the
   * dispatch path so dispatch refusals land before the row ever
   * parks. "queued" while the wait holds, "busy-expired" past
   * `routeBusyWaitSeconds`, null on a free slot. */
  busyGate?: () => Promise<"queued" | "busy-expired" | null>;
  /** §20.1 п.5: routes already skipped in this dispatch. */
  _skipped?: { route: string; reason: string }[];
  specBeforeCode?: boolean;
  immutableBaseSha?: string;
}

/**
 * §20.1 п.5: the quota groups a delegation occupies for the
 * `maxActive` busy count — a policy route's own `quotaGroup`; a
 * `preset:` one-off shares the groups of every policy route on its
 * provider (same idea as `quotaGroupsForOneOff`, minus the model
 * lookup the busy check cannot afford per pass).
 */
export function quotaGroupsOfRow(
  row: DelegationRow,
  policy: Policy | null,
): Set<string> {
  if (!row.route.startsWith("preset:")) {
    const route = findRoute(policy, row.route);
    return new Set([
      canonicalQuotaGroup(
        route ? quotaGroupOf(route, row.route, policy) : row.route,
        policy,
      ),
    ]);
  }
  const canon = canonicalQuotaGroup(row.route, policy);
  const groups = new Set([canon]);
  if (canon.startsWith("preset:")) {
    const p = canon.slice("preset:".length);
    for (const n of routeNameChain(p, policy?.presetAliases).slice(1)) {
      groups.add(`preset:${n}`);
    }
  }
  if (policy) {
    for (const [name, route] of Object.entries(policy.routes)) {
      if (route.provider === row.provider) {
        groups.add(quotaGroupOf(route, name, policy));
      }
    }
  }
  return groups;
}

export async function dispatchToRoute(
  row: DelegationRow,
  opts: DispatchOpts,
  deps: DispatchStepsDeps,
): Promise<DispatchStepsResult> {
  const t = deps.t ?? T_RU;
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const policy = deps.policy?.() ?? null;
  const role = roleForLevel(row.level, policy);
  const policyRoute = row.route.startsWith("preset:")
    ? undefined
    : findRoute(policy, row.route);

  // §31.9 (ADR-0032): Unified check before code launch across all routes / reissues / fallbacks
  if (role === "executor" && !row.no_code) {
    const taskRow = store.getTask(row.task_key);
    const mode =
      typeof deps.workGraphMode === "function"
        ? (deps.workGraphMode as any)(row.project_id)
        : deps.workGraphMode;
    const taskRepoRoot =
      deps.repoRoot ??
      (deps.resolveRepoRoot ? await deps.resolveRepoRoot(row) : undefined);
    const effectiveProj = row.project_id ?? taskRow?.project_id;
    const proj = effectiveProj && deps.resolveProject
      ? await Promise.resolve(deps.resolveProject(effectiveProj)).catch(() => null)
      : (deps.project ?? null);
    try {
      let resolvedBaseSha = opts.from;
      if (resolvedBaseSha && deps.cmd && taskRepoRoot && !/^[0-9a-fA-F]{40}$/.test(resolvedBaseSha)) {
        try {
          const rev = await deps.cmd.run("git", ["rev-parse", resolvedBaseSha], { cwd: taskRepoRoot });
          if (rev.exitCode === 0 && rev.stdout.trim().length === 40) {
            resolvedBaseSha = rev.stdout.trim();
          }
        } catch {}
      }
      const presetName = (opts as any)?.preset ?? row.preset;
      const presetBaseBranch = await resolvePresetBaseBranch(presetName, {
        bbCli: deps.bbCli,
        policy,
        presetDetails: (policy as any)?.presetDetails,
      });
      let executorBaseSha: string | undefined = opts.immutableBaseSha;
      if (!executorBaseSha && deps.cmd && taskRepoRoot) {
        try {
          executorBaseSha = await resolveExecutorBaseSha({
            cmd: deps.cmd,
            repoRoot: taskRepoRoot,
            from: opts.from,
            baseBranch: presetBaseBranch ?? (proj as any)?.baseBranch ?? (policy as any)?.baseBranch,
          });
        } catch {}
      }
      if (executorBaseSha) {
        opts.immutableBaseSha = executorBaseSha;
      }
      await verifySpecBeforeCodeGate({
        taskKey: row.task_key,
        role,
        noCode: Boolean(row.no_code),
        level: row.level,
        store,
        cmd: deps.cmd,
        policy,
        project: proj,
        baseSha: executorBaseSha,
        preparedBaseSha: resolvedBaseSha ?? executorBaseSha,
        baseBranchName: presetBaseBranch,
        presetName,
        workGraphMode: mode,
        specBeforeCode: opts.specBeforeCode,
        repoRoot: taskRepoRoot,
        task: taskRow,
      });
    } catch (err: any) {
      if (err?.code === "spec-gate-violation") {
        if (opts.onDispatchFailure === "fail") {
          store.setStatus(row.id, "failed");
        }
      }
      throw err;
    }
  }

  /**
   * §20.1 п.5: hand this `dispatching` row to the next usable chain
   * route (busy-wait expired). Returns the follow-up dispatch result,
   * or null when the chain is exhausted.
   */
  const advanceRoute = async (
    reason: string,
  ): Promise<DispatchStepsResult | null> => {
    const level = policy?.levels[row.level];
    if (!policy || !level) return null;
    const held = store.heldGroups(now());
    const canonHeld = new Set(
      [...held].map((h) => canonicalQuotaGroup(h, policy)),
    );
    const unavailable = deps.unavailableRoutes?.() ?? new Set<string>();
    const matchRoute = (a: string, b: string) =>
      a === b ||
      canonicalRouteName(a, policy) === canonicalRouteName(b, policy);
    const idx = level.chain.findIndex((c) => matchRoute(c, row.route));
    // The route just burned and every route this dispatch already
    // skipped are out — an explicit --route/--preset inside the chain
    // continues from ITS position (`updateRoute` also drops
    // `explicit_route`), never restarts into itself (ревью r33: that
    // restart recursed dispatchToRoute → advanceRoute forever).
    const skipped = new Set((opts._skipped ?? []).map((s) => s.route));
    skipped.add(row.route);
    const namesOf = (name: string) =>
      routeNameChain(name, policy.routeAliases);
    const isSkipped = (name: string) =>
      namesOf(name).some((n) => skipped.has(n));
    const isUnavailable = (name: string) =>
      namesOf(name).some((n) => unavailable.has(n));
    const candidates =
      idx === -1 ? level.chain : level.chain.slice(idx + 1);
    for (const name of candidates) {
      if (isSkipped(name) || isUnavailable(name)) continue;
      const next = findRoute(policy, name);
      if (!next) continue;
      const qg = quotaGroupOf(next, name, policy);
      if (
        namesOf(name).some((n) => held.has(n)) ||
        held.has(qg) ||
        canonHeld.has(qg)
      ) {
        continue;
      }
      const resolved = resolvePolicyRoute(policy, name);
      const targetName = resolved?.name ?? name;
      const targetRoute = resolved?.route ?? next;
      if (
        !store.updateRoute(row.id, {
          route: targetName,
          preset: targetRoute.preset,
          provider: targetRoute.provider,
        })
      ) {
        return null; // left `dispatching` meanwhile — another path owns it
      }
      (opts._skipped ??= []).push({ route: row.route, reason });
      const nextOpts: DispatchOpts = { ...opts, immutableBaseSha: undefined };
      return dispatchToRoute(store.get(row.id) ?? row, nextOpts, deps);
    }
    return null;
  };

  // §20.1 п.5 «маршрут занят»: a route with `maxActive` parks the row
  // `dispatching` under `queued_at` instead of falling to the next
  // route at once; `routeBusyWaitSeconds` out → the next route. The
  // gate runs INSIDE the dispatch path so a refusal lands at once
  // instead of parking the row behind a route it would never reach.
  const routeCap = policyRoute?.maxActive;
  const busyGate =
    policyRoute !== undefined && routeCap !== undefined
      ? async (): Promise<"queued" | "busy-expired" | null> => {
          const group = quotaGroupOf(policyRoute, row.route, policy);
          // A freed slot goes to the first parked row: rows ahead of
          // this one are the dispatched ones (no queued_at) plus the
          // claims parked earlier — a newcomer queues behind every
          // parked row, a parked row only behind older claims. Helpers
          // on the same quotaGroup occupy a slot like a running row.
          // A row's queue rank — a dispatched row (-1) is ahead of
          // everyone; a parked claim keeps its queued_at position; a
          // row still dispatching (no thread, no queued_at) ranks LAST
          // so it neither occupies a slot it never claimed nor blocks
          // parked rows. Two parallel dispatchers tie on MAX and the
          // lower id wins — the later one queues instead of BOTH
          // parking behind a phantom.
          const rank = (x: DelegationRow) =>
            x.thread_id !== null
              ? -1
              : (x.queued_at ?? Number.MAX_SAFE_INTEGER);
          const myRank = rank(row);
          const busy =
            store
              .listActive()
              .filter(
                (r) =>
                  r.id !== row.id &&
                  quotaGroupsOfRow(r, policy).has(group) &&
                  (rank(r) < myRank ||
                    (rank(r) === myRank && r.id < row.id)),
              ).length +
            store
              .listActiveHelpers()
              .filter((h) => {
                if (h.route === null) return false;
                const hr = findRoute(policy, h.route);
                return (
                  (hr
                    ? quotaGroupOf(hr, h.route, policy)
                    : canonicalQuotaGroup(h.route, policy)) === group
                );
              }).length;
          if (busy >= routeCap) {
            if (row.queued_at == null) {
              store.setQueuedAt(row.id, now());
              return "queued";
            }
            const waitMs =
              (policyRoute.routeBusyWaitSeconds ??
                DEFAULT_ROUTE_BUSY_WAIT_SECONDS) * 1000;
            if (now() - row.queued_at < waitMs) return "queued";
            return "busy-expired";
          }
          // A free slot (or a first dispatch). The row keeps its
          // `queued_at` claim through this gate; the spawn path below
          // resets it right before spawning (`setQueuedAt(null)`) so a
          // later `dispatch-unknown` lands in the §7 reconcile, not
          // back in the queue-retry branch.
          return null;
        }
      : undefined;

  // §2.2: the «Работа с git» section leads --instructions; a continuation
  // round then adds «Заход N» (§4.1) — or, for auditor levels, the
  // «Проверяемый итог» line instead (§4.1 r23: a read-only role gets no
  // merge commands) — a `no_code` row drops the git memo entirely (§4.1
  // r28.1: its commit requirements would contradict the «задача без кода»
  // line) — then this call's extra instructions. In this shared step they
  // cover the §5.4 reissue path too.
  // §21.2: a researcher level's row gets neither the git memo nor the
  // round lines — its contract is the report, not commits.
  const resultRef =
    row.continue_from && role !== "researcher"
      ? store.resultRefForSha(row.task_key, row.continue_from)
      : null;
  const spec = parseAttachSpec(row.attach);
  // §20.1 п.4: the `--attach` paths ride in the instructions as a
  // list — the agent opens them in its own working copy.
  const attachLine = spec.paths.length
    ? t("instr.attachList", { list: spec.paths.join(", ") })
    : undefined;
  const contractForTask = resolveTaskSpecContract(row.task_key, store, null);
  const mechanicalPrompt =
    role === "auditor" &&
    contractForTask?.kind === "mechanical" &&
    contractForTask.mechanicalBasis
      ? `Внимание: задача заявлена как механическая работа без изменения поведения (§31.9).\nЗаявленное основание: "${contractForTask.mechanicalBasis}".\nПроверь по фактическому диффу, что изменения действительно носят исключительно механический характер и не изменяют поведение системы.`
      : undefined;
  const extra =
    [opts.instructions?.trim(), attachLine?.trim(), mechanicalPrompt?.trim()]
      .filter(Boolean)
      .join("\n\n") || undefined;
  const instructions = mergeDispatchInstructions(
    role === "researcher" || role === "architect" ? undefined : deps.gitInstructions?.(),
    extra,
    row.continue_from && role !== "researcher"
      ? role === "auditor" || role === "architect"
        ? reviewRoundLine(
            row.continue_from,
            resultRef?.branch,
            resultRef?.round,
            t,
          )
        : roundSection(
            row.round,
            row.continue_from,
            resultRef?.branch,
            t,
          )
      : undefined,
    row.no_code === 1,
    t,
  );
  const innerOpts: DispatchOpts = {
    ...opts,
    busyGate,
  };
  // §4 r30: the plugin spawns the executor itself — the parent,
  // `hidden`, `parentNotifications=auto` and the
  // `pluginMetadata.delegationId` label are set at creation, so no
  // `ownership-assigned` wakes the coordinator and an uncertain result
  // stays findable by the label. The `bb tasks dispatch` fallback
  // survives for a schema refusal on the parent/visibility fields only
  // (r30 е 3); every other refusal is final — no fallback.
  try {
    const res = await dispatchViaSpawn(row, instructions, innerOpts, deps);
    if (opts._skipped?.length) res.skipped = opts._skipped;
    return res;
  } catch (e) {
    if (e instanceof RouteBusyExpired) {
      const advanced = await advanceRoute("route-busy");
      if (advanced) return advanced;
      await refuseDispatch(
        row,
        opts,
        deps,
        (deps.t ?? T_RU)("del.routeBusyExhausted", { route: row.route }),
        "route-busy-timeout",
      );
    }
    if (!(e instanceof SpawnSchemaRefusal)) throw e;
    const t = deps.t ?? T_RU;
    store.addSetupError(
      row.id,
      "own-spawn",
      t("del.ownSpawnUnavailable", { error: message(e) }),
    );
    try {
      const res = await dispatchViaTasksCli(row, instructions, innerOpts, deps);
      if (opts._skipped?.length) res.skipped = opts._skipped;
      return res;
    } catch (e2) {
      // The fallback path surfaces the same outcomes as the primary
      // one — a burned route advances (r33 ревью 2).
      if (e2 instanceof RouteBusyExpired) {
        const advanced = await advanceRoute("route-busy");
        if (advanced) return advanced;
        await refuseDispatch(
          row,
          opts,
          deps,
          t("del.routeBusyExhausted", { route: row.route }),
          "route-busy-timeout",
        );
      }
      throw e2;
    }
  }
}

/** §20.1 п.5: the parked wait ran out inside the dispatch path — the
 * row moves to the next chain route (`dispatchToRoute` handles it). */
class RouteBusyExpired extends Error {
  constructor() {
    super("route-busy");
    this.name = "RouteBusyExpired";
  }
}

/** Thrown inside `dispatchViaSpawn` when the server refuses the spawn at
 * the schema level over the parent/visibility fields (r30 е 3) — the
 * only outcome that falls back to `bb tasks dispatch`. */
class SpawnSchemaRefusal extends Error {
  constructor(message_: string) {
    super(message_);
    this.name = "SpawnSchemaRefusal";
  }
}

/** The plugin-sdk HTTP error shape: `Error` + `code: string|null` +
 * numeric `status` (+ optional `details`). */
interface BbHttpError extends Error {
  code: string | null;
  status: number;
  details?: { reason?: string; message?: string };
}

function isBbHttpError(e: unknown): e is BbHttpError {
  return (
    e instanceof Error &&
    "status" in e &&
    typeof (e as { status?: unknown }).status === "number" &&
    "code" in e &&
    (typeof (e as { code?: unknown }).code === "string" ||
      (e as { code?: unknown }).code === null)
  );
}

const OWN_SPAWN_FIELDS_RE =
  /parent_?thread_?id|parent_?notifications|visibility/i;
const SCHEMA_WORDING_RE =
  /unrecogni[sz]ed|unknown|unexpected|not allowed|invalid|missing|required|strict/i;
const SCHEMA_REFUSAL_CODES = new Set([
  "invalid_request",
  "invalid_params",
  "bad_request",
  "unrecognized_keys",
  "validation_error",
]);

/** r30 е 3: a 4xx whose wording pins the refusal to the own-spawn fields
 * — `parentThreadId`, `parentNotifications`, `visibility`. A generic
 * provider/preset/target 4xx stays an explicit refusal, no fallback. */
function isSpawnSchemaRefusal(e: unknown): boolean {
  if (!isBbHttpError(e) || e.status < 400 || e.status >= 500) return false;
  if (e.code !== null && !SCHEMA_REFUSAL_CODES.has(e.code)) return false;
  const text = `${e.message} ${JSON.stringify(e.details ?? {})}`;
  return OWN_SPAWN_FIELDS_RE.test(text) && SCHEMA_WORDING_RE.test(text);
}

/** r30 в: the tasks plugin's `mapSpawnTargetError` — a `new-worktree`
 * spawn whose target is unusable surfaces as `spawn_target_invalid`
 * with the wording BB's delegate produces. */
const SPAWN_TARGET_ERROR_CODES = new Set([
  "host_not_found",
  "host_unavailable",
  "invalid_request",
  "project_unavailable",
  "unsupported_host",
  "workspace_unavailable",
]);

function mapSpawnTargetError(
  e: unknown,
  p: PresetShowResponse["preset"],
): unknown {
  if (
    p?.environmentKind === "new-worktree" &&
    isBbHttpError(e) &&
    e.code !== null &&
    SPAWN_TARGET_ERROR_CODES.has(e.code)
  ) {
    const msg = e.message.replace(/^HTTP \d+:\s*/u, "");
    return Object.assign(
      new Error(
        `Could not create a worktree on ${p.machineId ?? "the default machine"} ` +
          `from ${p.baseBranch ?? "the default branch"}: ${msg}`,
      ),
      { code: "spawn_target_invalid", status: e.status },
    );
  }
  return e;
}

/* ── §4 r30 (б): the BB `buildSeedPrompt` template, copied so the
 * executor's first message looks exactly like a `bb tasks dispatch`
 * seed. Template drift on bb upgrades is the accepted risk — the whole
 * template lives here and a test pins its sections. */

const WIDE_GRAPHEME_RE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Yi}⺀-〾㈀-㏿︰-﹯！-｠￠-￦]/u;
const EMOJI_GRAPHEME_RE =
  /^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F|[#*0-9]\uFE0F?\u20E3)/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

const graphemeWidth = (g: string) =>
  g.length === 0
    ? 0
    : EMOJI_GRAPHEME_RE.test(g) || WIDE_GRAPHEME_RE.test(g)
      ? 2
      : 1;

/** BB `truncateToWidth`: clip to a display width (CJK/emoji count 2). */
export function truncateToWidth(text: string, width: number): string {
  let used = 0;
  let end = 0;
  for (const seg of GRAPHEME_SEGMENTER.segment(text)) {
    const next = used + graphemeWidth(seg.segment);
    if (next > width) break;
    used = next;
    end = seg.index + seg.segment.length;
  }
  return text.slice(0, end);
}

/** BB `delegatedThreadTitle`: `KEY · title`, display width ≤ 120. */
export const delegatedThreadTitle = (key: string, title: string) =>
  truncateToWidth(`${key} · ${title}`, 120);

const SECTION = (name: string, body: string) => `## ${name}\n\n${body}`;

/** §4 r30 (б): BB 0.49.0 `buildSeedPrompt`, same sections and order. */
export function buildSeedPrompt(input: {
  task: { key: string; title: string; description?: string };
  project: { name?: string; linkedBbProjectId?: string | null };
  subtasks: NonNullable<TaskShowResponse["subtasks"]>;
  attachments: NonNullable<TaskShowResponse["attachments"]>;
  recentComments: NonNullable<TaskShowResponse["comments"]>;
  presetInstructions?: string;
  extraInstructions?: string;
}): string {
  const sections = [
    `# ${input.task.key} · ${input.task.title}`,
    SECTION(
      "Description",
      (input.task.description ?? "").trim() || "No description provided.",
    ),
    SECTION(
      "Project context",
      `- Name: ${input.project.name}\n` +
        `- Linked bb project: ${input.project.linkedBbProjectId ?? "Not linked"}`,
    ),
    SECTION(
      "Sub-tasks",
      input.subtasks.length
        ? input.subtasks
            .map((t) => `- ${t.key} · ${t.title} (${t.status})`)
            .join("\n")
        : "None.",
    ),
    SECTION(
      "Attachments",
      input.attachments.length
        ? input.attachments
            .map(
              (t) =>
                `- ${t.fileName} · ${t.id}\n` +
                `  Fetch with: bb tasks attachment get ${t.id} --out <path>`,
            )
            .join("\n")
        : "None.",
    ),
    SECTION(
      "Recent comments",
      input.recentComments.length
        ? input.recentComments
            .map(
              (t) =>
                `### ${t.authorName} · ${t.kind} · ${t.createdAt}\n\n${t.body}`,
            )
            .join("\n\n")
        : "None.",
    ),
    SECTION(
      "Report-back contract",
      `You are working on task ${input.task.key}. Use the bb tasks CLI: ` +
        `comment substantive updates (bb tasks comment ${input.task.key} ` +
        `--body ...), attach result artifacts, set status when done ` +
        `(bb tasks update ${input.task.key} --status in_review) or ` +
        `explain blockage in a comment. Your thread is already attached ` +
        `to the task.`,
    ),
  ];
  sections.push(
    ...instructionSections(input.presetInstructions, input.extraInstructions),
  );
  return `${sections.join("\n\n")}\n`;
}

/** The «Preset instructions»/«Additional instructions» sections of the
 * seed prompt. */
function instructionSections(
  presetInstructions?: string,
  extraInstructions?: string,
): string[] {
  const out: string[] = [];
  if (presetInstructions?.trim()) {
    out.push(SECTION("Preset instructions", presetInstructions.trim()));
  }
  if (extraInstructions?.trim()) {
    out.push(SECTION("Additional instructions", extraInstructions.trim()));
  }
  return out;
}

/* ── dispatch paths ── */

/** An explicit refusal known before — or decided after — the dispatch
 * attempt: the refusal comment (caller-initiated only), then remove the
 * record (`onDispatchFailure: remove`, §4 п.3) or mark it `failed`
 * (`fail` — the §5.4 reissue rows must never silently vanish) and throw
 * `dispatch-failed` — or the caller's own code (`route-busy-timeout`,
 * `preset-not-allowed`). */
async function refuseDispatch(
  row: DelegationRow,
  opts: DispatchOpts,
  deps: DispatchStepsDeps,
  detail: string,
  code = "dispatch-failed",
): Promise<never> {
  const t = deps.t ?? T_RU;
  // §17.2 (e2e 6 + PLUG-211 С4): an undispatchable route (bad reasoning
  // level, removed model) leaves its reason as a task comment — once.
  // The watchdog reissue path skips this (its `report` comments the
  // task itself); only caller-initiated dispatches opt in.
  if (opts.commentOnRefusal) {
    try {
      await runChecked(deps.bbCli, [
        "tasks",
        "comment",
        row.task_key,
        "--body",
        t("del.dispatchRefused", {
          route: row.route,
          detail: detail.slice(0, 500),
        }),
      ]);
    } catch {
      // A failed comment must not hide the dispatch refusal itself.
    }
  }
  if (opts.onDispatchFailure === "fail") {
    deps.store.setStatus(row.id, "failed");
  } else {
    deps.store.remove(row.id);
  }
  throw new OrchestratorError(code, detail);
}

type UnknownDispatch = (detail: string) => OrchestratorError;

/** A pre-spawn CLI read (`tasks show`, `preset show`): a timeout or an
 * unreadable answer is `dispatch-unknown` (the row survives for the
 * §7 reconcile), a nonzero exit is an explicit refusal. */
async function runJsonStep<T>(
  bbCli: BbCli,
  args: string[],
  timeoutMs: number | undefined,
  unknownDispatch: UnknownDispatch,
  refuse: (detail: string) => Promise<never>,
): Promise<T> {
  const res = await bbCli.run(args, { timeoutMs: timeoutMs ?? 120_000 });
  const cmd = args.slice(0, 3).join(" ");
  if (res.timedOut) throw unknownDispatch(`bb ${cmd} timed out`);
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || "no output";
    await refuse(`bb ${cmd} failed (exit ${res.exitCode}): ${detail}`);
  }
  try {
    return JSON.parse(res.stdout.trim()) as T;
  } catch {
    throw unknownDispatch(`bb ${cmd} returned no JSON`);
  }
}

/** §4 r30 (а–д): own executor spawn — `tasks show` + `preset show` →
 * the BB seed prompt → `threads.spawn` (parent, `hidden`,
 * notifications and the `delegationId` label set at creation) →
 * `thread_id` at once → the shared finish steps.
 *
 * Outcomes (r30 е): a schema refusal on the parent/visibility fields
 * throws `SpawnSchemaRefusal` → `dispatchToRoute` falls back to
 * `bb tasks dispatch`; another 4xx is an explicit refusal (`code` +
 * `details.reason` to the caller, `onDispatchFailure` honoured, NO
 * fallback); a timeout/disconnect/5xx/unreadable result is
 * `dispatch-unknown` — the row stays `dispatching` without `thread_id`
 * and the §7 reconcile finds the thread by its label. A fatal failure
 * AFTER the spawn stops the created thread before the record is
 * removed or failed, so no executor is left unwatched. */
async function dispatchViaSpawn(
  row: DelegationRow,
  instructions: string | undefined,
  opts: DispatchOpts,
  deps: DispatchStepsDeps,
): Promise<DispatchStepsResult> {
  const t = deps.t ?? T_RU;
  const { store, bbCli } = deps;
  const unknownDispatch: UnknownDispatch = (detail) =>
    new OrchestratorError(
      "dispatch-unknown",
      t("del.dispatchUnknown", { detail }),
      t("del.dispatchUnknownHint"),
    );
  const refuse = (detail: string) => refuseDispatch(row, opts, deps, detail);

  // (а) The task row: linked bb project, title, description, sub-tasks,
  // attachments, comments.
  const shown = await runJsonStep<TaskShowResponse>(
    bbCli,
    ["tasks", "show", row.task_key, "--json"],
    deps.dispatchTimeoutMs,
    unknownDispatch,
    refuse,
  );
  const task = shown.task;
  if (!task?.id || !task.key || typeof task.title !== "string") {
    await refuse(`bb tasks show ${row.task_key}: task payload incomplete`);
  }
  const linkedBbProjectId = shown.project?.linkedBbProjectId;
  if (!linkedBbProjectId) {
    await refuse(
      `bb tasks show ${row.task_key}: project is not linked to a bb project`,
    );
  }

  // (а) The preset: provider, model, reasoning, tier, permission,
  // environment.
  const presetShow = await runJsonStep<PresetShowResponse>(
    bbCli,
    ["tasks", "preset", "show", row.preset, "--json"],
    deps.dispatchTimeoutMs,
    unknownDispatch,
    refuse,
  );
  const p = presetShow.preset;
  // A preset without modelId/reasoningLevel is NOT refused — the field is
  // left out of the spawn args and BB applies its default, exactly like
  // `bb tasks dispatch` does (r30 review: builtin dispatch never requires
  // them).
  const missing = (
    ["providerId", "permissionMode", "environmentKind"] as const
  ).filter((k) => !p?.[k]);
  if (!p || missing.length) {
    await refuse(
      `bb tasks preset show ${row.preset}: missing ${missing.join(", ")}`,
    );
  }

  // (в) The environment from the preset — `presetSpawnEnvironment`.
  let environment: unknown;
  // §22.2: set when the published-base check could not run — the
  // delegate response carries «база не проверена: <причина>».
  let baseUnchecked: string | undefined;
  if (p!.environmentKind === "project-default") {
    environment = { type: "project-default" };
  } else {
    let hostId = p!.machineId ?? "";
    if (!hostId) {
      try {
        hostId = await deps.primaryHostId();
      } catch (e) {
        throw unknownDispatch(`system.config: ${message(e)}`);
      }
    }
    if (!hostId) {
      await refuse(
        "spawn_target_invalid: Could not create a worktree because " +
          "BB has no default machine",
      );
    }
    // §22.2: the copy's base is `origin/<baseBranch>` after a fresh
    // fetch — never the local branch of the project copy, which may
    // carry unpushed commits the executor would silently inherit. An
    // explicit `--from` on a local target branch with such commits
    // refuses `from-unpublished`; a fetch/branch failure refuses
    // `base-unavailable`. The check skips where git is unreachable
    // (another host, no local_path source, no runner) — the response
    // then names the reason («база не проверена: <причина>»).
    const base = await delegateBase(deps, {
      projectId: linkedBbProjectId!,
      hostId,
      baseBranchName: p!.baseBranch ?? null,
      from: opts.from,
      taskKey: row.task_key,
      callerProjectId: row.project_id ?? null,
    });
    if ("refuse" in base) {
      await refuse(base.refuse);
    } else {
      if (base.kind === "skip") {
        baseUnchecked = t("del.baseUnchecked", {
          reason: t(`del.baseSkip.${base.reason}`),
        });
      }
      environment = {
        type: "host",
        hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch:
            opts.immutableBaseSha && row.round === 1 && !opts.from
              ? { kind: "named", name: opts.immutableBaseSha }
              : base.kind === "skip"
                ? p!.baseBranch
                  ? { kind: "named", name: p!.baseBranch }
                  : { kind: "default" }
                : base,
        },
      };
    }
  }

  // (б) The BB seed prompt and the `KEY · title` width-120 title.
  const title = delegatedThreadTitle(task!.key!, task!.title!);
  const prompt = buildSeedPrompt({
    task: { key: task!.key!, title: task!.title!, description: task!.description },
    project: shown.project ?? {},
    subtasks: shown.subtasks ?? [],
    attachments: shown.attachments ?? [],
    recentComments: (shown.comments ?? []).slice(-5),
    presetInstructions: p!.instructions,
    extraInstructions: instructions,
  });

  // §20.1 п.5 «маршрут занят»: the busy gate sits before the spawn —
  // a refusal lands at once instead of parking the row behind a route
  // it would never reach.
  const gate = await opts.busyGate?.();
  if (gate === "queued") {
    return { threadId: null, status: "queued", setupErrors: [] };
  }
  if (gate === "busy-expired") throw new RouteBusyExpired();

  // §20.1 п.5: past the gate the row gives its queue claim back —
  // `queued_at` resets BEFORE the spawn. A `dispatch-unknown` after
  // this point must land in the §7 reconcile (postDispatchGrace + the
  // `delegationId` label search), not in the queue-retry branch, which
  // would spawn duplicates without either safeguard.
  if (row.queued_at != null) store.setQueuedAt(row.id, null);

  // (в)+(д): spawn — the server stamps `originPluginId = "orchestrator"`;
  // `pluginMetadata.delegationId` is the §7 label; no
  // `lifecycleOwnerThreadId` (as under dispatch).
  let spawned: { id?: string };
  try {
    spawned = await deps.threads.spawn({
      projectId: linkedBbProjectId!,
      environment,
      providerId: p!.providerId,
      model: p!.modelId || undefined,
      reasoningLevel: p!.reasoningLevel || undefined,
      ...(p!.serviceTier ? { serviceTier: p!.serviceTier } : {}),
      permissionMode: p!.permissionMode,
      title,
      prompt,
      parentThreadId: row.coordinator_thread_id,
      parentNotifications: expectedParentNotify(row.level),
      visibility: "hidden",
      pluginMetadata: { delegationId: row.id },
    });
  } catch (e) {
    if (isSpawnSchemaRefusal(e)) {
      throw new SpawnSchemaRefusal(message(e));
    }
    const mapped = mapSpawnTargetError(e, p);
    if (
      isBbHttpError(mapped) &&
      mapped.status >= 400 &&
      mapped.status < 500
    ) {
      const reason =
        mapped.details?.reason ?? mapped.details?.message ?? mapped.message;
      await refuse(
        `spawn refused${mapped.code ? ` (${mapped.code})` : ""}: ${reason}`,
      );
    }
    throw unknownDispatch(`threads.spawn: ${message(e)}`);
  }
  const threadId =
    typeof spawned?.id === "string" && spawned.id ? spawned.id : null;
  if (!threadId) {
    throw unknownDispatch("threads.spawn returned no thread id");
  }

  // (г) Persist `thread_id` at once — then the shared finish steps. A
  // fatal failure before `running` stops the created thread so it is not
  // left without supervision (r30 е 2).
  try {
    store.setThreadInfo(row.id, threadId, task!.id);
    const linked = store.get(row.id) ?? row;
    const done = await finishDispatchSteps(linked, deps, {
      levelNote: opts.levelNote,
      taskStatus: task!.status,
    });
    return {
      threadId,
      status: done.status,
      setupErrors: done.setupErrors,
      baseUnchecked,
    };
  } catch (fatal) {
    try {
      await deps.threads.stop({ threadId });
    } catch {
      // best effort — the record is failed/removed below anyway
    }
    if (store.get(row.id)?.status === "cancelled") {
      // A cancel that landed meanwhile already owns the outcome.
      return { threadId, status: "cancelled", setupErrors: [], baseUnchecked };
    }
    if (opts.onDispatchFailure === "fail") {
      store.setStatus(row.id, "failed");
    } else {
      store.remove(row.id);
    }
    throw new OrchestratorError(
      "dispatch-failed",
      t("del.dispatchAfterSpawn", { error: message(fatal) }),
    );
  }
}

/** §4 п.3 fallback (r30 е 3): `bb tasks dispatch --json` — reachable
 * only when the own-spawn path hit a schema refusal on the
 * parent/visibility fields; the tasks plugin attaches the thread itself
 * and `finishDispatchSteps` repairs the parent binding after. */
async function dispatchViaTasksCli(
  row: DelegationRow,
  instructions: string | undefined,
  opts: DispatchOpts,
  deps: DispatchStepsDeps,
): Promise<DispatchStepsResult> {
  const { store, bbCli } = deps;
  const cliInstructions = instructions;

  // §20.1 п.5 «маршрут занят»: the fallback honors the same busy gate
  // (r33 ревью 2: a schema refusal on a busy route must queue/advance
  // exactly like the primary path).
  const gate = await opts.busyGate?.();
  if (gate === "queued") {
    return { threadId: null, status: "queued", setupErrors: [] };
  }
  if (gate === "busy-expired") throw new RouteBusyExpired();
  // §20.1 п.5: same release as the spawn path — a dispatch
  // timeout/unknown below goes to the §7 reconcile, not back to the
  // queue-retry branch.
  if (row.queued_at != null) store.setQueuedAt(row.id, null);

  const dispatchRes = await bbCli.run(
    [
      "tasks",
      "dispatch",
      row.task_key,
      "--preset",
      row.preset,
      ...(cliInstructions ? ["--instructions", cliInstructions] : []),
      "--json",
    ],
    { timeoutMs: deps.dispatchTimeoutMs ?? 120_000 },
  );
  const t = deps.t ?? T_RU;
  const unknownDispatch = () =>
    new OrchestratorError(
      "dispatch-unknown",
      t("del.dispatchUnknown", {
        detail: t("del.dispatchUnclean", { code: dispatchRes.exitCode }),
      }),
      t("del.dispatchUnknownHint"),
    );
  if (dispatchRes.exitCode !== 0 && !dispatchRes.timedOut) {
    const detail =
      dispatchRes.stderr.trim() || dispatchRes.stdout.trim() || "no output";
    await refuseDispatch(
      row,
      opts,
      deps,
      `bb tasks dispatch failed (exit ${dispatchRes.exitCode}): ${detail}`,
    );
  }
  if (dispatchRes.timedOut) throw unknownDispatch();
  let dispatch: DispatchResponse;
  try {
    dispatch = JSON.parse(dispatchRes.stdout.trim()) as DispatchResponse;
  } catch {
    throw unknownDispatch();
  }
  const threadId = dispatch.threadId;
  if (!threadId) throw unknownDispatch();
  store.setThreadInfo(row.id, threadId, dispatch.task?.id);
  const linked = store.get(row.id) ?? row;

  const done = await finishDispatchSteps(linked, deps, {
    levelNote: opts.levelNote,
  });
  return { threadId, status: done.status, setupErrors: done.setupErrors };
}

/** §4 r30 (г): `bb tasks attach` + the conditional `in_progress` move —
 * the FIRST finish substep so both the dispatch and a
 * `dispatching`+`thread_id` reconcile run it (a crash between the
 * `thread_id` write and the attach is retried under `tasks-attach`).
 * Idempotent in tasks (`ON CONFLICT … DO UPDATE`); the fallback path's
 * repeat attach only rewrites the preset name to «Attached». */
async function attachTaskToThread(
  row: DelegationRow,
  threadId: string,
  taskStatus: string | undefined,
  deps: DispatchStepsDeps,
): Promise<void> {
  await runChecked(deps.bbCli, [
    "tasks",
    "attach",
    row.task_key,
    "--thread",
    threadId,
  ]);
  const status =
    taskStatus ??
    (
      await runJson<TaskShowResponse>(deps.bbCli, [
        "tasks",
        "show",
        row.task_key,
        "--json",
      ])
    ).task?.status;
  if (status === "backlog" || status === "todo") {
    await runChecked(deps.bbCli, [
      "tasks",
      "update",
      row.task_key,
      "--status",
      "in_progress",
    ]);
  }
}

/** §4 r30: verify the binding instead of blind updates — a thread
 * spawned with the parent/`hidden`/`auto` at creation already matches,
 * and a match performs NO `threads.update` (an update on the parent
 * field sends `ownership-assigned`). A read error throws and retries
 * next pass without touching the thread; a confirmed mismatch is
 * re-applied (SDK for parent+visibility, CLI for `parentNotifications` —
 * the SDK 0.4.87 type lacks the field). A confirmed binding marks
 * `attach-verified=auto` so the running reconcile stops re-reading. */
async function verifyParentBinding(
  row: DelegationRow,
  threadId: string,
  deps: DispatchStepsDeps,
): Promise<void> {
  const show = await runJson<{
    thread?: {
      parentThreadId?: string | null;
      parentNotifications?: string | null;
      visibility?: string | null;
    };
  }>(deps.bbCli, ["thread", "show", threadId, "--json"]);
  const facts = show.thread ?? {};
  const want = expectedParentNotify(row.level);
  const parentOk = facts.parentThreadId === row.coordinator_thread_id;
  const notifyOk = facts.parentNotifications === want;
  const hiddenOk = facts.visibility === "hidden";
  if (parentOk && notifyOk && hiddenOk) {
    deps.store.addSetupError(row.id, "attach-verified", want);
    return;
  }
  if (!parentOk || !hiddenOk) {
    await deps.threads.update({
      threadId,
      parentThreadId: row.coordinator_thread_id,
      visibility: "hidden",
    });
  }
  if (!notifyOk) {
    await runChecked(deps.bbCli, [
      "thread",
      "update",
      threadId,
      "--parent-notifications",
      want,
    ]);
  }
}

/**
 * §4 steps 4–6 on a `dispatching` row that already has `thread_id`:
 * `bb tasks attach` + `in_progress` (r30 г — first substep), the binding
 * verify, best-effort `mode=bypass`, `dispatching`→`running` (a cancel
 * that landed meanwhile wins and the created thread is stopped),
 * «Раздано» comment. Errors land in `setup_errors`; the §7 reconcile
 * retries them.
 */
export async function finishDispatchSteps(
  row: DelegationRow,
  deps: DispatchStepsDeps,
  opts: { levelNote?: string; taskStatus?: string } = {},
): Promise<{ status: "running" | "cancelled"; setupErrors: SetupError[] }> {
  const t = deps.t ?? T_RU;
  const { store, bbCli } = deps;
  const threadId = row.thread_id;
  if (!threadId) {
    throw new OrchestratorError(
      "internal-error",
      t("del.noThreadId", { id: row.id }),
    );
  }
  const setupErrors: SetupError[] = [];
  const noteError = (step: string, e: unknown) => {
    const err = { step, message: message(e) };
    setupErrors.push(err);
    store.addSetupError(row.id, err.step, err.message);
  };

  // Step 4 (r30 г) — task attach first, then the binding verify.
  try {
    await attachTaskToThread(row, threadId, opts.taskStatus, deps);
  } catch (e) {
    noteError("tasks-attach", e);
  }
  try {
    await verifyParentBinding(row, threadId, deps);
  } catch (e) {
    noteError("attach", e);
  }

  // §4 step 4 / §13.2 + §2.3: record the executor's role — auditor levels
  // (policy `role` or the historical `review`) map to `auditor`,
  // everything else to `executor`. The upsert corrects a role the hook
  // may already have guessed from the title alone; a corrected role
  // applies from the next session build. Display metadata mirrors it
  // (§13.2 п.4) — `thread_roles` stays the source of truth.
  const role = roleForLevel(row.level, deps.policy?.());
  try {
    store.setThreadRole(threadId, role, "delegate");
  } catch (e) {
    noteError("thread-role", e);
  }
  if (deps.threads.updatePluginMetadata) {
    try {
      await deps.threads.updatePluginMetadata({
        threadId,
        set: { role },
      });
    } catch (e) {
      noteError("role-metadata", e);
    }
  }

  await ensureBypassMode(row, noteError, deps);

  // Step 6 — `running` only from `dispatching`: a cancel that landed while
  // dispatch ran wins, and the executor it created is stopped here. A
  // record that vanished or left `dispatching` any other way means the
  // dispatch is finished WITHOUT supervision — the spawned thread is
  // stopped too (r30 е 2), then the mismatch is recorded.
  if (!store.setStatusIf(row.id, "dispatching", "running")) {
    const current = store.get(row.id);
    if (current?.status === "cancelled") {
      try {
        await deps.threads.stop({ threadId });
      } catch (e) {
        noteError("cancel-stop", e);
      }
      return { status: "cancelled", setupErrors };
    }
    try {
      await deps.threads.stop({ threadId });
    } catch (e) {
      noteError("cancel-stop", e);
    }
    // r30 (в): the dispatch is REFUSED — dispatchViaSpawn's catch marks
    // the record `failed` or drops it and the caller gets
    // `dispatch-failed`; no «Раздано» comment for an unsupervised thread.
    throw new OrchestratorError(
      "internal-error",
      t("del.leftDispatching", {
        status: current?.status ?? "missing",
      }),
    );
  }
  try {
    await runChecked(bbCli, [
      "tasks",
      "comment",
      row.task_key,
      "--body",
      t("del.comment", {
        note: opts.levelNote ?? t("del.levelWord", { level: row.level }),
        route: row.route,
        preset: row.preset,
        threadId,
      }),
    ]);
  } catch (e) {
    noteError("comment", e);
  }

  return { status: "running", setupErrors };
}

/** §4 step 5 — best-effort `mode=bypass` for `permissionMode=full` presets. */
async function ensureBypassMode(
  row: DelegationRow,
  noteError: (step: string, e: unknown) => void,
  deps: DispatchStepsDeps,
): Promise<void> {
  const threadId = row.thread_id;
  if (!threadId) return;
  try {
    await ensureBypassModeOrThrow(row, threadId, deps);
  } catch (e) {
    noteError("bypass-mode", e);
  }
}

/**
 * Returns `true` when the step is settled for this delegation — the
 * preset is not `full`, or the session already reported its options
 * (mode set, already `bypass`, or `bypass` not offered). An empty options
 * list means the session is still building → `false`, retry next pass.
 */
async function ensureBypassModeOrThrow(
  row: DelegationRow,
  threadId: string,
  deps: DispatchStepsDeps,
): Promise<boolean> {
  const show = await runJson<{ preset?: { permissionMode?: string } }>(
    deps.bbCli,
    ["tasks", "preset", "show", row.preset, "--json"],
  );
  if (show.preset?.permissionMode !== "full") return true;
  const opts = await runJson<{
    options?:
      | {
          id?: string;
          name?: string;
          value?: unknown;
          values?: unknown[];
        }[]
      | null;
  }>(deps.bbCli, ["thread", "options", threadId, "--json"]);
  const options = opts.options ?? [];
  if (!options.length) return false; // §4.5: retry while options unseen
  const mode = options.find(
    (o) => o.id === "mode" || o.name === "mode",
  );
  const offers = (mode?.values ?? []).some((v) =>
    typeof v === "string" ? v === "bypass" : (v as { id?: string }).id === "bypass",
  );
  if (offers && mode?.value !== "bypass") {
    await runChecked(deps.bbCli, [
      "thread",
      "options",
      threadId,
      "--set",
      "mode=bypass",
    ]);
  }
  return true;
}

/**
 * §4.5 retries step 5 only while the session can still be building its
 * options — bounded by the delegation's age so reconcile does not spend
 * two CLI calls per row per minute forever.
 */
const BYPASS_RETRY_WINDOW_MS = 30 * 60 * 1000;

/**
 * §7 reconcile helper for `running` rows: retry the §4.4–4.6 steps that
 * `setup_errors` recorded as failed — plus step 5 while inside the retry
 * window (session options can be empty right after dispatch; the preset
 * check is the only cost). A successful attempt clears its recorded error.
 */
export async function retrySetupSteps(
  row: DelegationRow,
  deps: DispatchStepsDeps,
): Promise<SetupError[]> {
  const t = deps.t ?? T_RU;
  const { store } = deps;
  const threadId = row.thread_id;
  if (!threadId) return [];

  let recorded: Set<string>;
  try {
    const parsed = JSON.parse(row.setup_errors) as { step?: string }[];
    recorded = new Set(
      (Array.isArray(parsed) ? parsed : [])
        .map((e) => e?.step)
        .filter((s): s is string => typeof s === "string"),
    );
  } catch {
    recorded = new Set();
  }

  const errors: SetupError[] = [];
  const attempt = async (step: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      store.clearSetupError(row.id, step);
    } catch (e) {
      store.clearSetupError(row.id, step);
      const msg = message(e);
      store.addSetupError(row.id, step, msg);
      errors.push({ step, message: msg });
    }
  };

  // §4 r30 (г): the attach is retried under `tasks-attach`; the binding
  // retry re-VERIFIES first so an already-correct thread gets no
  // `threads.update` (no `ownership-assigned`).
  if (recorded.has("tasks-attach")) {
    await attempt("tasks-attach", () =>
      attachTaskToThread(row, threadId, undefined, deps),
    );
  }
  if (recorded.has("attach")) {
    await attempt("attach", () => verifyParentBinding(row, threadId, deps));
  }
  if (recorded.has("parent-notifications")) {
    await attempt("parent-notifications", () =>
      runChecked(deps.bbCli, [
        "thread",
        "update",
        threadId,
        "--parent-notifications",
        expectedParentNotify(row.level),
      ]),
    );
  }
  // §4.5 "пока сессия не сообщит опции": retry while the options list is
  // empty — and stop for good once it reported (marked `bypass-settled`)
  // or the delegation outgrew the retry window.
  if (
    Date.now() - row.created_at < BYPASS_RETRY_WINDOW_MS &&
    !store.findSetupError(row, "bypass-settled")
  ) {
    try {
      if (await ensureBypassModeOrThrow(row, threadId, deps)) {
        store.addSetupError(row.id, "bypass-settled", "options reported");
        store.clearSetupError(row.id, "bypass-mode");
      }
    } catch (e) {
      const msg = message(e);
      store.clearSetupError(row.id, "bypass-mode");
      store.addSetupError(row.id, "bypass-mode", msg);
      errors.push({ step: "bypass-mode", message: msg });
    }
  }
  if (recorded.has("thread-role")) {
    await attempt("thread-role", async () => {
      store.setThreadRole(
        threadId,
        roleForLevel(row.level, deps.policy?.()),
        "delegate",
      );
    });
  }
  if (recorded.has("role-metadata") && deps.threads.updatePluginMetadata) {
    await attempt("role-metadata", () =>
      deps.threads.updatePluginMetadata!({
        threadId,
        set: { role: roleForLevel(row.level, deps.policy?.()) },
      }),
    );
  }
  if (recorded.has("comment")) {
    await attempt("comment", () =>
      runChecked(deps.bbCli, [
        "tasks",
        "comment",
        row.task_key,
        "--body",
        t("del.comment", {
          note: t("del.levelWord", { level: row.level }),
          route: row.route,
          preset: row.preset,
          threadId,
        }),
      ]),
    );
  }
  if (recorded.has("cancel-stop")) {
    await attempt("cancel-stop", () => deps.threads.stop({ threadId }));
  }
  return errors;
}

/** Serialize delegate calls inside this process (§4): the unique index is
 * the cross-process guard, the chain makes same-process races impossible. */
export function createDelegateQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
