/**
 * The single `bb.agents.configure` selection module (spec §3). It decides
 * whether the resolved thread is a coordinator and what the plugin gives it.
 * Later stages extend this module: PLUG-141 adds role instructions and
 * `thread_roles` lookups.
 *
 * §13: a `thread_roles` row decides by `delegates`; the §3 fallback
 * criterion covers threads with no row — no parent and no executor marker:
 *   1. `origin.pluginId === "tasks"` (a thread created by `bb tasks dispatch`);
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
  ROLES,
  type RoleId,
} from "./roles.js";

export const COORDINATOR_TOOLS = [
  "orchestrator_delegate",
  "orchestrator_status",
  "orchestrator_cancel",
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
}

/**
 * The criterion minus its storage probes — used when the store itself is the
 * thing that failed (the §3 resilience rule: on error, fall back to the
 * cheapest facts we can compute and warn in the log).
 */
export function isCoordinatorByStaticFacts(facts: ThreadFacts): boolean {
  if (facts.parentThreadId !== null && facts.parentThreadId !== undefined) {
    return false;
  }
  if (facts.originPluginId === "tasks") return false;
  if (facts.title && DISPATCH_TITLE_RE.test(facts.title)) return false;
  return true;
}

/** The §3 question for a decided role; an unknown id delegates nothing. */
const roleDelegates = (roleId: string): boolean =>
  ROLES[roleId as RoleId]?.delegates === true;

export function isCoordinator(
  facts: ThreadFacts,
  probes: ExecutorProbes,
  now: number = Date.now(),
): boolean {
  // §3/§13: a recorded role answers by `delegates`; only threads without a
  // `thread_roles` row fall back to the executor markers.
  const roleId = probes.roleByThreadId?.(facts.threadId);
  if (roleId !== undefined) return roleDelegates(roleId);
  if (!isCoordinatorByStaticFacts(facts)) return false;
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
  // decision. No row → the §3 fallback criterion.
  const roleId = deps.probes.roleByThreadId?.(facts.threadId);
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
    if (deps.injectInstructions) config.instructions = role.instructions;
    return config;
  }

  // §16.7 r25: policy invalid + no decided role → setup skill only.
  if (deps.policyOk === false && roleId === undefined) {
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
    const roleText = (role ?? ROLES.orchestrator).instructions;
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
): PluginAgentConfiguration {
  const coordinator = isCoordinatorByStaticFacts({
    threadId: context.thread.id,
    parentThreadId: context.thread.parentThreadId,
    title: context.thread.title,
    originPluginId: context.origin.pluginId,
    projectId: context.project.id,
  });
  if (!coordinator) return { tools: [], skills: [] };
  const config: PluginAgentConfiguration = {
    tools: [...COORDINATOR_TOOLS],
    skills: injectInstructions
      ? [SKILL_COORDINATOR, SKILL_SETUP]
      : [SKILL_SETUP],
  };
  // §3 rev 16: the fallback criterion yields the orchestrator role's
  // issuance — instruction + rule — without recording anything.
  if (injectInstructions) {
    config.instructions = `${ROLES.orchestrator.instructions}

${instructionsText}`;
  }
  return config;
}
