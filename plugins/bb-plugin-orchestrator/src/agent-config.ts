/**
 * The single `bb.agents.configure` selection module (spec §3). It decides
 * whether the resolved thread is a coordinator and what the plugin gives it.
 * Later stages extend this module: PLUG-138 adds the coordinator/setup
 * skills, PLUG-141 adds role instructions and `thread_roles` lookups.
 *
 * MVP coordinator test is the §3 fallback criterion: the thread has no
 * parent and shows no executor marker:
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

export const COORDINATOR_TOOLS = [
  "orchestrator_delegate",
  "orchestrator_status",
  "orchestrator_cancel",
] as const;

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

export function isCoordinator(
  facts: ThreadFacts,
  probes: ExecutorProbes,
  now: number = Date.now(),
): boolean {
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
  const coordinator = isCoordinator(
    facts,
    deps.probes,
    deps.now ? deps.now() : Date.now(),
  );
  if (!coordinator) {
    return { tools: [], skills: [] };
  }
  const config: PluginAgentConfiguration = {
    tools: [...COORDINATOR_TOOLS],
    // PLUG-138 adds `orchestrator-coordinator`/`orchestrator-setup` here.
    skills: [],
  };
  if (deps.injectInstructions) {
    config.instructions = deps.instructionsText;
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
    skills: [],
  };
  if (injectInstructions) config.instructions = instructionsText;
  return config;
}
