/**
 * The single `bb.agents.configure` selection module (spec §3). It decides
 * whether the resolved thread is a coordinator and what the plugin gives it.
 * Later stages extend this module: PLUG-141 adds role instructions and
 * `thread_roles` lookups.
 *
 * §13: a `thread_roles` row decides by `delegates`; the §3 fallback
 * criterion covers threads with no row — no parent and no executor marker:
 *   1. `origin.pluginId === "tasks"` (a thread created by `bb tasks
 *      dispatch`) or `"orchestrator"` (§4 r30 д — the own spawn);
 *   2. the thread id is recorded in `delegations.thread_id`;
 *   3. the title looks like a dispatch title `<KEY> · …`;
 *   4. a `dispatching` row without `thread_id` younger than two minutes
 *      exists — the window between INSERT (§4 step 2) and the dispatch
 *      result, when the executor's first `configure` can already run.
 */
import type {
  PluginAgentConfiguration,
  PluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk";
import {
  DEFAULT_USER_THREAD_PLUGINS,
  NO_ROLE,
  ROLES,
  type RoleId,
} from "./roles.js";
import type { DelegationStore } from "./store.js";

export const COORDINATOR_TOOLS = [
  "orchestrator_delegate",
  "orchestrator_status",
  "orchestrator_cancel",
  "orchestrator_merge",
] as const;

/**
 * §2.1/§3: coordinator skills. `orchestrator-setup` is always given —
 * setup must happen before the first delegation even when texts are off;
 * `orchestrator-coordinator` only when `injectInstructions = true`.
 */
export const SKILL_SETUP = "orchestrator-setup";
export const SKILL_COORDINATOR = "orchestrator-coordinator";

/** Dispatch titles are `<KEY> · <task title>` (e.g. `PLUG-129 · …`). */
export const DISPATCH_TITLE_RE = /^[A-Z][A-Z0-9]+-\d+ · /;

const FRESH_DISPATCHING_WINDOW_MS = 2 * 60 * 1000;

export interface ThreadFacts {
  threadId: string;
  parentThreadId: string | null;
  title: string | null;
  originPluginId: string | null;
  /** bb project of the thread; the fresh-dispatching marker is per-project. */
  projectId: string;
}

/** Storage probes the criterion needs; injected so tests stay in-memory. */
export interface ExecutorProbes {
  delegationByThreadId(threadId: string): unknown;
  /**
   * True when a `dispatching` row without `thread_id` younger than two
   * minutes exists in the candidate's own project, excluding rows the
   * candidate itself dispatched — its own in-flight delegation does not
   * make a coordinator an executor.
   */
  hasFreshDispatching(
    freshSince: number,
    scope: { projectId: string; excludingThreadId: string },
  ): boolean;
  /**
   * §13.2: the role `thread_roles` recorded for this thread, or undefined.
   * A row decides the §3 question on its own (`delegates`); no row falls
   * through to the fallback criterion.
   */
  roleByThreadId?(threadId: string): string | undefined;
  /**
   * §17.1 r26 (PLUG-211 Б1): the lazy-rewrite sink — a stale `orchestrator`
   * row on a plugin-born thread is corrected to `none` on sight.
   */
  writeRole?(threadId: string, role: string): void;
  /**
   * §17.1 r26 (PLUG-211 Б2): plugin ids whose threads continue a human
   * chat — they are not "plugin-born" for the role rule. Absent probe =
   * the default `["handoff", "external-compact"]`.
   */
  userThreadPlugins?(): readonly string[];
}

/**
 * The criterion minus its storage probes — used when the store itself is the
 * thing that failed (the §3 resilience rule: on error, fall back to the
 * cheapest facts we can compute and warn in the log).
 */
export function isCoordinatorByStaticFacts(
  facts: ThreadFacts,
  userThreadPlugins: readonly string[] = DEFAULT_USER_THREAD_PLUGINS,
): boolean {
  if (facts.parentThreadId !== null && facts.parentThreadId !== undefined) {
    return false;
  }
  // §17.1 (аудит Б3): a plugin-born thread — `tasks` dispatch included —
  // is never a default coordinator; it carries no dispatch tools or
  // coordinator instructions. §17.1 r26 (PLUG-211 Б2): except a
  // userThreadPlugins plugin — its thread IS the continued human chat.
  if (
    facts.originPluginId !== null &&
    facts.originPluginId !== undefined &&
    !userThreadPlugins.includes(facts.originPluginId)
  ) {
    return false;
  }
  if (facts.title && DISPATCH_TITLE_RE.test(facts.title)) return false;
  return true;
}

/** The §3 question for a decided role; an unknown id delegates nothing. */
const roleDelegates = (roleId: string): boolean =>
  ROLES[roleId as RoleId]?.delegates === true;

/**
 * §17.1 r26 (PLUG-211 Б1 + PLUG-215 Б1): the recorded role, with the
 * lazy rewrite in BOTH directions — a stale `orchestrator` row on a
 * plugin-born thread outside `userThreadPlugins` predates the r26 rule
 * (the hook would write `none` today), and a `none` row on a parentless
 * thread whose plugin IS in `userThreadPlugins` predates the plugin's
 * addition to the list (the hook would write `orchestrator` today).
 * Both are corrected on sight; the one-time `migratePluginThreadRoles`
 * pass covers what configure never reaches. A parented `none` row
 * stands: the parent rule beats the plugin list (§17.1), so the hook
 * would write `executor`, and `none` already keeps the thread from the
 * coordinator issuance.
 */
export function effectiveRoleId(
  facts: ThreadFacts,
  probes: ExecutorProbes,
): string | undefined {
  const roleId = probes.roleByThreadId?.(facts.threadId);
  const userPlugins =
    probes.userThreadPlugins?.() ?? DEFAULT_USER_THREAD_PLUGINS;
  const pluginBorn =
    facts.originPluginId !== null && facts.originPluginId !== undefined;
  if (
    roleId === "orchestrator" &&
    pluginBorn &&
    !userPlugins.includes(facts.originPluginId!)
  ) {
    probes.writeRole?.(facts.threadId, NO_ROLE);
    return NO_ROLE;
  }
  if (
    roleId === NO_ROLE &&
    pluginBorn &&
    (facts.parentThreadId === null ||
      facts.parentThreadId === undefined) &&
    userPlugins.includes(facts.originPluginId!)
  ) {
    probes.writeRole?.(facts.threadId, "orchestrator");
    return "orchestrator";
  }
  return roleId;
}

export function isCoordinator(
  facts: ThreadFacts,
  probes: ExecutorProbes,
  now: number = Date.now(),
): boolean {
  // §3/§13: a recorded role answers by `delegates`; only threads without a
  // `thread_roles` row fall back to the executor markers.
  const roleId = effectiveRoleId(facts, probes);
  if (roleId !== undefined) return roleDelegates(roleId);
  if (
    !isCoordinatorByStaticFacts(
      facts,
      probes.userThreadPlugins?.() ?? DEFAULT_USER_THREAD_PLUGINS,
    )
  ) {
    return false;
  }
  if (probes.delegationByThreadId(facts.threadId)) return false;
  if (
    probes.hasFreshDispatching(now - FRESH_DISPATCHING_WINDOW_MS, {
      projectId: facts.projectId,
      excludingThreadId: facts.threadId,
    })
  ) {
    return false;
  }
  return true;
}

export interface AgentConfigDeps {
  injectInstructions: boolean;
  /** Generated §3 routing rule, or the setup hint when policy is unusable. */
  instructionsText: string;
  probes: ExecutorProbes;
  now?: () => number;
  /**
   * §16.7 r25: while the policy is invalid a role-less root thread gets
   * ONLY the setup skill — no coordinator tools or routing text (the
   * orchestrator does not work anyway). `undefined` = treated as valid.
   */
  policyOk?: boolean;
  /**
   * §18.6: the effective role text — built-in body + `roleTexts` addition
   * + mandatory tail, `{handoff}`/`{review}` substituted. Defaults to the
   * role's static `instructions` (the plugin defaults).
   */
  roleInstructions?(role: RoleId): string;
}

export function buildAgentConfiguration(
  context: PluginAgentConfigurationContext,
  deps: AgentConfigDeps,
): PluginAgentConfiguration {
  const facts: ThreadFacts = {
    threadId: context.thread.id,
    parentThreadId: context.thread.parentThreadId,
    title: context.thread.title,
    originPluginId: context.origin.pluginId,
    projectId: context.project.id,
  };
  // §13.2 п.3: `configure` only reads `thread_roles` — it never writes a
  // decision (the §17.1 r26 lazy rewrite in `effectiveRoleId` is a
  // correction, not a decision). No row → the §3 fallback criterion.
  const roleId = effectiveRoleId(facts, deps.probes);
  const role = roleId !== undefined ? ROLES[roleId as RoleId] : undefined;
  const coordinator =
    roleId !== undefined
      ? role?.delegates === true
      : isCoordinator(facts, deps.probes, deps.now ? deps.now() : Date.now());

  if (!coordinator) {
    // §3: other roles get their own instruction (when texts are on) and
    // their own tools/skills — both empty for the MVP executor/auditor,
    // and for a role id this plugin does not know.
    if (!role) return { tools: [], skills: [] };
    const config: PluginAgentConfiguration = {
      tools: [...role.tools],
      skills: [...role.skills],
    };
    if (deps.injectInstructions) {
      config.instructions =
        deps.roleInstructions?.(role.id) ?? role.instructions;
    }
    return config;
  }

  // §16.7 r25 (PLUG-182): policy invalid + a coordinator (a role-less
  // root thread OR a recorded `orchestrator` role — the new-chat window
  // writes that pick itself) → setup skill only, no tools or texts.
  if (deps.policyOk === false) {
    return { tools: [], skills: [SKILL_SETUP] };
  }

  const config: PluginAgentConfiguration = {
    tools: [...COORDINATOR_TOOLS],
    skills: deps.injectInstructions
      ? [SKILL_COORDINATOR, SKILL_SETUP]
      : [SKILL_SETUP],
  };
  if (deps.injectInstructions) {
    // §3 rev 16: a fallback-decided coordinator (no `thread_roles` row)
    // gets the same text as the `orchestrator` role — its instruction
    // plus the routing rule; the row itself is still not written.
    // Budget: instruction ≤ 2500 + rule ≤ 1500 + separator ≤ 4096.
    const coordinatorRole = role ?? ROLES.orchestrator;
    const roleText =
      deps.roleInstructions?.(coordinatorRole.id) ??
      coordinatorRole.instructions;
    config.instructions = `${roleText}

${deps.instructionsText}`;
  }
  return config;
}

/** Fallback used when `buildAgentConfiguration` itself throws (§3
 * resilience): static facts only, so a broken store cannot take the
 * coordinator's tools away. */
export function fallbackAgentConfiguration(
  context: PluginAgentConfigurationContext,
  injectInstructions: boolean,
  instructionsText: string,
  /** §16.7: `false` → a coordinator gets the setup skill only. */
  policyOk: boolean = true,
  /** §17.1 r26 (PLUG-211 Б2): user-continuation plugin ids. */
  userThreadPlugins: readonly string[] = DEFAULT_USER_THREAD_PLUGINS,
  /** §18.6: the effective orchestrator text (roleTexts + handoffPath). */
  orchestratorText: string = ROLES.orchestrator.instructions,
): PluginAgentConfiguration {
  const coordinator = isCoordinatorByStaticFacts(
    {
      threadId: context.thread.id,
      parentThreadId: context.thread.parentThreadId,
      title: context.thread.title,
      originPluginId: context.origin.pluginId,
      projectId: context.project.id,
    },
    userThreadPlugins,
  );
  if (!coordinator) return { tools: [], skills: [] };
  if (!policyOk) return { tools: [], skills: [SKILL_SETUP] };
  const config: PluginAgentConfiguration = {
    tools: [...COORDINATOR_TOOLS],
    skills: injectInstructions
      ? [SKILL_COORDINATOR, SKILL_SETUP]
      : [SKILL_SETUP],
  };
  // §3 rev 16: the fallback criterion yields the orchestrator role's
  // issuance — instruction + rule — without recording anything.
  if (injectInstructions) {
    config.instructions = `${orchestratorText}

${instructionsText}`;
  }
  return config;
}

/**
 * §17.1 r26 (PLUG-211 Б1): the one-time rewrite — hook-decided
 * `orchestrator` rows on plugin-born threads outside `userThreadPlugins`
 * become the `none` verdict the hook would write today. `configure`'s
 * lazy fix covers rows this pass cannot reach; the caller marks the pass
 * in `plugin_meta`. Rows whose origin lookup fails are skipped (next
 * configure still fixes them lazily when the thread lives).
 */
export async function migratePluginThreadRoles(
  store: DelegationStore,
  opts: {
    threadOriginPluginId(
      threadId: string,
    ): Promise<string | null | undefined>;
    userThreadPlugins?: readonly string[];
    log?: { warn?(message: string): void };
  },
): Promise<number> {
  const userPlugins = opts.userThreadPlugins ?? DEFAULT_USER_THREAD_PLUGINS;
  let moved = 0;
  for (const row of store.listThreadRoles({
    role: "orchestrator",
    source: "hook",
  })) {
    let pluginId: string | null | undefined;
    try {
      pluginId = await opts.threadOriginPluginId(row.thread_id);
    } catch (e) {
      opts.log?.warn?.(
        `orchestrator: role migration ${row.thread_id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      continue;
    }
    if (pluginId && !userPlugins.includes(pluginId)) {
      store.setThreadRole(row.thread_id, NO_ROLE, "hook");
      moved++;
    }
  }
  return moved;
}
