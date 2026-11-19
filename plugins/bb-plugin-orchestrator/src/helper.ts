/**
 * Helpers (spec §19.1–§19.6, r33): plugin-created worker threads — a
 * hidden child of the caller, running in the caller's OWN environment
 * (`{type:"reuse"}`), supervised by the watchdog, with the result
 * delivered by BB's parent notifications. No tracker task is created
 * or attached; the helper role is fixed (`helper`).
 *
 * Caller authorization (§19.1): a root `orchestrator`, a root
 * `executor`, a delegation's running executor thread, or a fork/side
 * chat inheriting one of those roles through `sourceThreadId`. Every
 * other caller (a helper itself, `none`, auditor, a role-less thread)
 * gets a stable refusal code; manual `bb thread spawn`/`bb tasks
 * dispatch` children are refused by the §19.5 hook gate instead.
 */

import { OrchestratorError } from "./errors.js";
import {
  canonicalQuotaGroup,
  canonicalRouteName,
  findRoute,
  resolvePolicyRoute,
  levelRole,
  pickRoute,
  quotaGroupOf,
  routeNameChain,
  samePreset,
  type PolicyLoad,
  type PolicyRoute,
} from "./policy.js";
import { NO_ROLE, isRoleId } from "./roles.js";
import {
  quotaGroupsOfRow,
  type SpawnThreadArgs,
} from "./delegate.js";
import type {
  DelegationStore,
  HelperRow,
} from "./store.js";
import type { T } from "./i18n/index.js";

/** §19.1: active helper statuses (dispatching counts — a spawn in
 * flight occupies its slot). */
const HELPER_ACTIVE = new Set(["dispatching", "running"]);

/** §19.1: a dispatching row without a found child is declared lost
 * after two minutes — same window as §4's fresh-dispatching marker. */
const HELPER_DISPATCH_GRACE_MS = 2 * 60 * 1000;

/** §19.6: a terminal helper's thread is archived after 24 h — never
 * deleted. */
const HELPER_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

/** §19.1: the typed quota signal — the same `errorInfo.category`
 * values the delegation watchdog treats as `quota`. */
const QUOTA_CATEGORIES = new Set(["rate-limit", "billing"]);

/** §19.1: the text fallback for quota classification (journal error
 * texts and `thread.failed` messages without a typed category). */
const QUOTA_TEXT =
  /quota|rate.?limit|429|insufficient\s+credits|usage limit/i;

/** §19.1: the caller facts `runHelper` needs — the gate inputs plus the
 * reuse target (`environmentId`) and the child's project. */
export interface HelperCallerFacts {
  threadId: string;
  parentThreadId: string | null;
  sourceThreadId?: string | null;
  originPluginId: string | null;
  projectId: string;
  environmentId: string | null;
  /** Thread lifecycle status (`active`, `idle`, …) — the CLI gate needs
   * it (§19.1: a CLI helper call requires an ACTIVE calling thread). */
  status?: string | null;
  /** §3-fallback input: the pre-r33 coordinator probe reads the title. */
  title?: string | null;
}

/** The `helpers` setting (§19.1 config): `maxActive` is the PER-CALLER
 * cap (default 3) — the shared pool is `policy.limits.maxActive`,
 * counted together with delegations. */
export interface HelpersSettings {
  maxActive: number;
  defaultLevel?: string;
}

export const DEFAULT_HELPERS: HelpersSettings = {
  maxActive: 3,
};

/** `helpers` setting JSON — `{maxActive?, maxPerCaller?, defaultLevel?}`;
 * bad values read as warnings and fall back to defaults (setup/status
 * surface the errors). */
export function parseHelpersSettings(
  raw: string,
  t: T,
): { config: HelpersSettings; errors: { path: string; message: string }[] } {
  const errors: { path: string; message: string }[] = [];
  const cfg: HelpersSettings = { ...DEFAULT_HELPERS };
  const trimmed = raw.trim();
  if (!trimmed) return { config: cfg, errors };
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch (e) {
    errors.push({
      path: "helpers",
      message: e instanceof Error ? e.message : String(e),
    });
    return { config: cfg, errors };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    errors.push({ path: "helpers", message: t("set.helpersNotObject") });
    return { config: cfg, errors };
  }
  const o = doc as Record<string, unknown>;
  const int = (key: "maxActive" | "maxPerCaller") => {
    const v = o[key];
    if (v === undefined) return;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
      // `maxPerCaller` — the pre-review name of the same per-caller cap;
      // accepted so existing settings keep working.
      cfg.maxActive = v;
    } else {
      errors.push({
        path: `helpers.${key}`,
        message: t("set.helpersBadInt"),
      });
    }
  };
  int("maxActive");
  int("maxPerCaller");
  if (o.defaultLevel !== undefined) {
    if (typeof o.defaultLevel === "string" && o.defaultLevel.trim()) {
      cfg.defaultLevel = o.defaultLevel.trim();
    } else {
      errors.push({
        path: "helpers.defaultLevel",
        message: t("set.helpersBadLevel"),
      });
    }
  }
  return { config: cfg, errors };
}

export interface SpawnHelperArgs extends SpawnThreadArgs {
  /** §19.1: the caller owns the helper's lifecycle — its archive/delete
   * cascades to the helper. */
  lifecycleOwnerThreadId?: string;
}

export interface HelperThreadDto {
  id: string;
  status?: string | null;
  createdAt?: number | null;
  parentThreadId?: string | null;
  originPluginId?: string | null;
  environmentId?: string | null;
  projectId?: string | null;
  visibility?: string | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
}

export interface HelperThreadEvent {
  seq: number;
  type: string;
  createdAt: number;
  data: Record<string, unknown>;
}

/** The `bb.sdk.threads` surface the helper paths use. */
export interface HelperThreads {
  get(args: { threadId: string }): Promise<HelperThreadDto>;
  spawn(args: SpawnHelperArgs): Promise<{ id?: string }>;
  send(args: {
    threadId: string;
    mode?: string;
    input: { type: string; text: string; mentions?: unknown[] }[];
  }): Promise<unknown>;
  stop(args: { threadId: string }): Promise<unknown>;
  list(args: {
    parentThreadId?: string;
    includeHidden?: boolean;
    limit?: number;
  }): Promise<{ id: string; createdAt?: number | null }[]>;
  getPluginMetadata?(args: {
    threadId: string;
  }): Promise<Record<string, unknown> | null | undefined>;
  /** §19.4: `role set … none` clears the role badge — `remove` takes
   * the metadata keys to delete. */
  updatePluginMetadata?(args: {
    threadId: string;
    set?: Record<string, unknown>;
    remove?: string[];
  }): Promise<unknown>;
  archive?(args: { threadId: string }): Promise<unknown>;
  events: {
    list(args: {
      threadId: string;
      afterSeq?: number;
      limit?: string | number;
      order?: "asc" | "desc";
      types?: readonly string[];
    }): Promise<HelperThreadEvent[]>;
  };
}

export interface HelperDeps {
  store: DelegationStore;
  threads: HelperThreads;
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  /** The live parsed policy (§19.1 needs-configuration input). */
  loadPolicy(): Promise<PolicyLoad>;
  helpers(): HelpersSettings;
  callerFacts(threadId: string): Promise<HelperCallerFacts>;
  /** §19.1: `bb tasks preset show <name> --json` — resolves the route's
   * preset into the provider/model fields `threads.spawn` needs (the
   * server spawn schema has no `preset` field — the preset is carried
   * BY its resolved fields, exactly like the delegate dispatch). */
  presetShow?(preset: string): Promise<{
    providerId?: string;
    modelId?: string | null;
    reasoningLevel?: string | null;
    serviceTier?: string | null;
    permissionMode?: string;
    instructions?: string;
  } | undefined>;
  /** §19.1 pre-r33 compatibility: a thread WITHOUT a role row may still
   * be a §3 coordinator (delegations were recorded before roles
   * existed). Returns true only for that shape. */
  isCoordinatorFallback?(caller: HelperCallerFacts): boolean;
  t: T;
  now?: () => number;
  log?: { warn?(m: string): void };
}

export interface HelperInput {
  prompt: string;
  title?: string;
  level?: string;
  preset?: string;
  /** The calling thread — tool's `ctx.threadId` or CLI's. */
  threadId?: string;
  /** §19.1: the entry point — a CLI call additionally requires the
   * calling thread to be `active`. */
  via?: "cli" | "tool";
}

export interface HelperResult {
  helperId: number;
  threadId?: string;
  preset: string;
  route: string;
  level: string;
  /** §19.1: the launch line — the CLI/tool prints it; the caller's own
   * turn is NOT woken by a plugin message. */
  message: string;
}

/** §19.1: `helper#<id> · <title>` at most 120 characters; without an
 * explicit title the first prompt words make it. */
export function helperTitle(id: number, base: string): string {
  const prefix = `helper#${id} · `;
  const room = Math.max(0, 120 - prefix.length);
  const cleaned = base.replace(/\s+/g, " ").trim();
  return prefix + cleaned.slice(0, room).trim();
}

const firstPromptWords = (prompt: string): string =>
  prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 10).join(" ");

/**
 * §19.1 caller gate — the recorded role decides (the hook already
 * resolved forks/side chats through `sourceThreadId`; a missing row on
 * a fork falls back to the source's role here).
 */
async function authorizeCaller(
  input: HelperInput,
  deps: HelperDeps,
): Promise<{ caller: HelperCallerFacts; role: string }> {
  if (!input.threadId) {
    throw new OrchestratorError(
      "no-caller-thread",
      "helper works only from a bb thread (BB_THREAD_ID is absent)",
      "run it inside a thread, or via the orchestrator_helper tool",
    );
  }
  const caller = await deps.callerFacts(input.threadId);
  // §19.1: a CLI helper call requires an ACTIVE calling thread — from a
  // suspended/queued thread only the tool path is allowed.
  if (
    input.via === "cli" &&
    caller.status !== undefined &&
    caller.status !== null &&
    caller.status !== "active"
  ) {
    throw new OrchestratorError(
      "caller-not-allowed",
      `helper via the CLI needs an active calling thread ` +
        `(status ${caller.status})`,
    );
  }
  let role = deps.store.threadRole(input.threadId)?.role;
  if (
    role === undefined &&
    caller.sourceThreadId !== null &&
    caller.sourceThreadId !== undefined
  ) {
    role = deps.store.threadRole(caller.sourceThreadId)?.role;
  }
  // §19.1: `none` and a missing role row share the stable refusal —
  // except the pre-r33 compatibility path: a row-less thread that the
  // §3 fallback still recognizes as a coordinator keeps working.
  if (role === undefined || role === null) {
    if (deps.isCoordinatorFallback?.(caller)) {
      role = "orchestrator";
    } else {
      throw new OrchestratorError(
        "no-role",
        `calling thread ${input.threadId} has no orchestrator role`,
        "a role is assigned on the thread's first message — or pick one in the new-chat window",
      );
    }
  }
  if (role === NO_ROLE) {
    throw new OrchestratorError(
      "no-role",
      `calling thread ${input.threadId} has role none — the plugin is off here`,
      "pick a role in the new-chat window or run `bb orchestrator role set`",
    );
  }
  if (role === "helper") {
    throw new OrchestratorError(
      "helper-of-helper",
      "a helper cannot launch helpers",
    );
  }
  const isRoot =
    caller.parentThreadId === null || caller.parentThreadId === undefined;
  const runningDelegation = deps.store.byThreadId(input.threadId);
  const executorOk =
    isRoot || runningDelegation?.status === "running";
  const allowed =
    (role === "orchestrator" && isRoot) ||
    (role === "executor" && executorOk);
  if (!allowed) {
    throw new OrchestratorError(
      "caller-not-allowed",
      `role ${role} may not launch helpers`,
      "allowed: a root orchestrator, a root executor, a running delegation executor",
    );
  }
  return { caller, role };
}

/** §19.1: resolve the route — a named preset maps to the policy route
 * carrying it (`preset-not-allowed` for foreign presets); a level goes
 * through `pickRoute`'s chain. `helpers.defaultLevel` applies ONLY when
 * no `--preset` is given (an explicit preset is never overridden), and
 * a defaultLevel outside the policy is `needs-configuration`, not a
 * silent fallback. Held quota groups count for both paths. */
function resolveRoute(
  input: HelperInput,
  policy: NonNullable<PolicyLoad["policy"]>,
  load: PolicyLoad,
  deps: HelperDeps,
): {
  level: string;
  routeName: string;
  preset: string;
  route: PolicyRoute;
} {
  const cfg = deps.helpers();
  const held = deps.store.heldGroups(deps.now?.() ?? Date.now());
  const canonHeld = new Set(
    [...held].map((h) => canonicalQuotaGroup(h, policy)),
  );
  if (input.preset !== undefined) {
    const found = Object.entries(policy.routes).find(([, r]) =>
      samePreset(policy, r.preset, input.preset),
    );
    if (!found) {
      throw new OrchestratorError(
        "preset-not-allowed",
        `preset "${input.preset}" is not in the policy`,
        "helpers run only on policy routes (ADR r33)",
      );
    }
    const [name, route] = found;
    const names = routeNameChain(name, policy.routeAliases);
    const qg = quotaGroupOf(route, name, policy);
    const isUnavailable = names.some((n) =>
      load.unavailableRoutes.includes(n),
    );
    const heldGroup =
      names.some((n) => held.has(n)) ||
      held.has(qg) ||
      canonHeld.has(qg);
    if (isUnavailable || heldGroup) {
      throw new OrchestratorError(
        "route-unavailable",
        `route "${name}" is unavailable (missing preset or route/quota hold)`,
      );
    }
    if (input.level !== undefined && !policy.levels[input.level]) {
      throw new OrchestratorError(
        "unknown-level",
        `level "${input.level}" is not in the policy`,
        `levels: ${Object.keys(policy.levels).join(", ")}`,
      );
    }
    return {
      level: input.level ?? name,
      routeName: name,
      preset: route.preset,
      route,
    };
  }
  if (input.level !== undefined) {
    if (!policy.levels[input.level]) {
      throw new OrchestratorError(
        "unknown-level",
        `level "${input.level}" is not in the policy`,
        `levels: ${Object.keys(policy.levels).join(", ")}`,
      );
    }
  } else if (cfg.defaultLevel !== undefined) {
    if (!policy.levels[cfg.defaultLevel]) {
      throw new OrchestratorError(
        "needs-configuration",
        `helpers.defaultLevel "${cfg.defaultLevel}" is not a policy level`,
        `levels: ${Object.keys(policy.levels).join(", ")}`,
      );
    }
  } else {
    throw new OrchestratorError(
      "invalid-arguments",
      "helper needs --level <level> or --preset <id> " +
        "(or helpers.defaultLevel in the settings)",
    );
  }
  const level = input.level ?? cfg.defaultLevel!;
  const picked = pickRoute(policy, level, {
    unavailableRoutes: new Set(load.unavailableRoutes),
    heldGroups: held,
  });
  return {
    level,
    routeName: picked.name,
    preset: picked.route.preset,
    route: picked.route,
  };
}

/** §19.1: the whole admission — gate, policy, route, the atomic
 * limit-checked row, the reuse spawn, the role write, the launch
 * notice. Runs inside `enqueue` so a concurrent `delegate`/`helper`
 * cannot race the limits. */
export async function runHelper(
  input: HelperInput,
  deps: HelperDeps,
): Promise<HelperResult> {
  return deps.enqueue(async () => {
    const { caller } = await authorizeCaller(input, deps);
    const load = await deps.loadPolicy();
    if (!load.policy) {
      throw new OrchestratorError(
        "needs-configuration",
        "the policy is not configured or is invalid",
        "setup — the orchestrator-setup skill, then `bb orchestrator policy validate`",
      );
    }
    const route = resolveRoute(input, load.policy, load, deps);
    // §20.1 п.5 (r34.4): a route's `maxActive` counts the whole
    // `quotaGroup` — active delegations AND helpers. A level pick
    // walks the rest of the chain for a usable non-busy route —
    // helpers never queue — while an explicit --preset refuses
    // `route-busy`.
    // r33 аудит C: a delegation occupies a slot only once it holds
    // something — `thread_id` (dispatched/running) or `queued_at` (a
    // parked claim, FIFO ahead of any new helper — a helper never
    // jumps the parked queue even in a freed-slot gap). A row still
    // dispatching (no thread, no queued_at) holds no claim — same
    // rank-LAST rule as the delegate busy gate.
    const groupBusy = (name: string, r: PolicyRoute): number => {
      const group = quotaGroupOf(r, name, load.policy);
      const delegations = deps.store
        .listActive()
        .filter(
          (d) =>
            (d.thread_id !== null || d.queued_at !== null) &&
            quotaGroupsOfRow(d, load.policy).has(group),
        ).length;
      const helpers = deps.store
        .listActiveHelpers()
        .filter((h) => {
          if (!h.route) return false;
          const hr = findRoute(load.policy, h.route);
          return (
            (hr
              ? quotaGroupOf(hr, h.route, load.policy)
              : canonicalQuotaGroup(h.route, load.policy)) === group
          );
        }).length;
      return delegations + helpers;
    };
    const busyRoute = (name: string, r: PolicyRoute) =>
      r.maxActive !== undefined && groupBusy(name, r) >= r.maxActive;
    const held = deps.store.heldGroups(deps.now?.() ?? Date.now());
    const canonHeld = new Set(
      [...held].map((h) => canonicalQuotaGroup(h, load.policy)),
    );
    const unavailable = new Set(load.unavailableRoutes);
    /** §20.1 п.5: the next usable chain route after `fromRoute` —
     * same filters for the busy walk (unavailable, held group, busy
     * quotaGroup). */
    const advanceChain = (
      fromRoute: string,
    ): { name: string; route: PolicyRoute } | undefined => {
      const chain = load.policy!.levels[route.level]?.chain ?? [];
      const matchRoute = (a: string, b: string) =>
        a === b ||
        canonicalRouteName(a, load.policy) ===
          canonicalRouteName(b, load.policy);
      const fromIdx = chain.findIndex((c) => matchRoute(c, fromRoute));
      const namesOf = (name: string) =>
        routeNameChain(name, load.policy?.routeAliases);
      const isUnavailable = (name: string) =>
        namesOf(name).some((n) => unavailable.has(n));
      for (const name of chain.slice(fromIdx === -1 ? 0 : fromIdx + 1)) {
        if (fromIdx === -1 && matchRoute(name, fromRoute)) continue;
        const r = findRoute(load.policy, name);
        if (!r || isUnavailable(name)) continue;
        const qg = quotaGroupOf(r, name, load.policy);
        if (
          namesOf(name).some((n) => held.has(n)) ||
          held.has(qg) ||
          canonHeld.has(qg) ||
          busyRoute(name, r)
        ) {
          continue;
        }
        const resolved = resolvePolicyRoute(load.policy, name);
        return resolved ?? { name, route: r };
      }
      return undefined;
    };
    if (busyRoute(route.routeName, route.route)) {
      const busyError = () =>
        new OrchestratorError(
          "route-busy",
          deps.t("cli.helperRouteBusy", { route: route.routeName }),
        );
      if (input.preset !== undefined) throw busyError();
      const next = advanceChain(route.routeName);
      if (!next) throw busyError();
      route.routeName = next.name;
      route.preset = next.route.preset;
      route.route = next.route;
    }
    if (caller.environmentId === null || caller.environmentId === undefined) {
      throw new OrchestratorError(
        "no-environment",
        `calling thread ${input.threadId} has no environment to reuse`,
        "helpers run inside the caller's environment — the caller must be running",
      );
    }
    const cfg = deps.helpers();
    const delegation = deps.store.byThreadId(input.threadId!);
    const row = deps.store.insertHelperChecked(
      {
        callerThreadId: input.threadId!,
        callerDelegationId:
          delegation &&
          (delegation.status === "running" ||
            delegation.status === "dispatching")
            ? delegation.id
            : null,
        coordinatorThreadId:
          delegation?.coordinator_thread_id ?? input.threadId!,
        projectId: caller.projectId,
        preset: route.preset,
        route: route.routeName,
        level: route.level,
        title: input.title ?? null,
      },
      {
        perCaller: cfg.maxActive,
        sharedMax: load.policy.limits?.maxActive,
      },
    );
    const title = helperTitle(
      row.id,
      input.title ?? firstPromptWords(input.prompt) ?? "helper",
    );
    // §19.1: the spawn carries the route's preset RESOLVED — the server
    // spawn schema has no `preset` field; provider/model/etc. carry it
    // (same mechanism as the delegate dispatch, §4 r30).
    const p = deps.presetShow
      ? await deps.presetShow(route.preset)
      : undefined;
    if (deps.presetShow && !p?.providerId) {
      deps.store.setHelperTerminal(row.id, "failed");
      throw new OrchestratorError(
        "dispatch-failed",
        `bb tasks preset show ${route.preset}: missing providerId`,
      );
    }
    const prompt = p?.instructions
      ? `${input.prompt}\n\n${p.instructions}`
      : input.prompt;
    let spawned: { id?: string } | undefined;
    try {
      spawned = await deps.threads.spawn({
        projectId: caller.projectId,
        environment: { type: "reuse", environmentId: caller.environmentId },
        ...(p?.providerId ? { providerId: p.providerId } : {}),
        ...(p?.modelId ? { model: p.modelId } : {}),
        ...(p?.reasoningLevel ? { reasoningLevel: p.reasoningLevel } : {}),
        ...(p?.serviceTier ? { serviceTier: p.serviceTier } : {}),
        ...(p?.permissionMode ? { permissionMode: p.permissionMode } : {}),
        title,
        prompt,
        parentThreadId: input.threadId,
        parentNotifications: "auto",
        lifecycleOwnerThreadId: input.threadId,
        visibility: "hidden",
        pluginMetadata: { helperId: row.id },
      });
    } catch (e) {
      // §19.1 spawn outcome: a 4xx is a definitive refusal → `failed`
      // and the error surfaces; anything else (timeout, 5xx, restart
      // mid-call) is UNKNOWN — the child may exist, so the row stays
      // `dispatching` and the watchdog relinks it by `helperId`.
      const status = httpStatus(e);
      if (status !== undefined && status >= 400 && status < 500) {
        deps.store.setHelperTerminal(row.id, "failed");
        throw new OrchestratorError(
          "dispatch-failed",
          `helper spawn refused: ${describeErr(e)}`,
        );
      }
      deps.log?.warn?.(
        `orchestrator: helper#${row.id} spawn outcome unknown — ` +
          `staying dispatching for the reconcile: ${describeErr(e)}`,
      );
      return {
        helperId: row.id,
        threadId: undefined,
        preset: route.preset,
        route: route.routeName,
        level: route.level,
        message: deps.t("cli.helperStarted", {
          id: row.id,
          preset: route.preset,
          thread: "—",
        }),
      };
    }
    const threadId = spawned?.id;
    if (threadId) {
      deps.store.setHelperThread(row.id, threadId);
      // §21.2: a helper on a researcher-role level gets the researcher
      // role (internet research, no project tools).
      const helperRole =
        levelRole(load.policy, route.level) === "researcher"
          ? "researcher"
          : levelRole(load.policy, route.level) === "architect"
            ? "architect"
            : "helper";
      deps.store.setThreadRole(threadId, helperRole, "delegate");
      deps.store.setHelperTurnStarted(row.id, deps.now?.() ?? Date.now());
      deps.store.setHelperStatusIf(row.id, "dispatching", "running");
    }
    // No id → the row stays `dispatching`; the watchdog reconciles it by
    // `pluginMetadata.helperId` within the grace window (§19.1). The
    // launch is reported by the RESULT line — the caller's own turn is
    // not woken by a plugin notice (the helper's result arrives via BB
    // parent notifications).
    return {
      helperId: row.id,
      threadId,
      preset: route.preset,
      route: route.routeName,
      level: route.level,
      message: deps.t("cli.helperStarted", {
        id: row.id,
        preset: route.preset,
        thread: threadId ?? "—",
      }),
    };
  });
}

/** The HTTP status an SDK error carries — 4xx is a definitive spawn
 * refusal; anything else leaves the outcome unknown. */
const httpStatus = (e: unknown): number | undefined => {
  const o = e as { status?: unknown; statusCode?: unknown } | undefined;
  const s = o?.status ?? o?.statusCode;
  return typeof s === "number" && Number.isFinite(s) ? s : undefined;
};

/** §19.1 cancellation: mark the row BEFORE stopping the thread, so the
 * watchdog reads the stop as plugin-owned. Without a known `thread_id`
 * the reconcile pass stops the child when it surfaces. */
export async function cancelHelper(
  ref: string,
  deps: HelperDeps,
  callerThreadId?: string,
): Promise<{ helperId: number; threadId?: string; already?: boolean }> {
  return deps.enqueue(async () => {
    const row = /^\d+$/.test(ref)
      ? deps.store.helper(Number(ref))
      : deps.store.helperByThreadId(ref);
    if (!row) {
      throw new OrchestratorError(
        "not-found",
        deps.t("cli.noHelper", { ref }),
      );
    }
    if (
      callerThreadId &&
      callerThreadId !== row.caller_thread_id &&
      callerThreadId !== row.coordinator_thread_id
    ) {
      throw new OrchestratorError(
        "caller-not-allowed",
        `thread ${callerThreadId} may not cancel helper#${row.id}`,
        "only the helper's caller or its delegation coordinator may cancel",
      );
    }
    if (!HELPER_ACTIVE.has(row.status)) {
      return { helperId: row.id, threadId: row.thread_id ?? undefined, already: true };
    }
    for (const from of ["dispatching", "running"] as const) {
      if (deps.store.setHelperStatusIf(row.id, from, "cancelled")) break;
    }
    if (row.thread_id) {
      await deps.threads
        .stop({ threadId: row.thread_id })
        .catch((e) =>
          deps.log?.warn?.(
            `orchestrator: helper#${row.id} stop: ${describeErr(e)}`,
          ),
        );
    }
    return { helperId: row.id, threadId: row.thread_id ?? undefined };
  });
}

/** §19.4 `role set <thread> <role>` — the ONLY manual change is the
 * downgrade to `none` (§19.4: «ручная запись допускает только none»);
 * every other target is `role-not-allowed`, a helper thread refuses
 * too, and the change clears the `pluginMetadata.role` badge. */
export async function runRoleSet(
  input: { threadId: string; role: string; actor?: string },
  deps: HelperDeps,
): Promise<{ threadId: string; role: string; previous: string | null }> {
  return deps.enqueue(async () => {
    if (input.role !== NO_ROLE) {
      throw new OrchestratorError(
        "role-not-allowed",
        `role "${input.role}" cannot be set manually`,
        "the only manual change is `role set <thread> none` — roles are assigned by the hook",
      );
    }
    // The target must exist — a typo must not write a role row for a
    // thread that is not there.
    const thread = await deps.threads
      .get({ threadId: input.threadId })
      .catch(() => undefined);
    if (!thread) {
      throw new OrchestratorError(
        "not-found",
        `thread ${input.threadId} does not exist`,
      );
    }
    const previous = deps.store.threadRole(input.threadId)?.role ?? null;
    if (previous === "helper") {
      throw new OrchestratorError(
        "role-not-allowed",
        "a helper thread's role is plugin-managed — it cannot be changed",
      );
    }
    const busy = deps.store.activeRoleParticipation(input.threadId);
    const active = Object.entries(busy).filter(([, v]) => v !== null);
    if (active.length) {
      throw new OrchestratorError(
        "role-active",
        `thread ${input.threadId} participates in active work: ` +
          active.map(([k, v]) => `${k}#${v}`).join(", "),
        "finish or cancel the delegations/helpers first",
      );
    }
    deps.store.setRoleManual(
      input.threadId,
      input.role,
      input.actor ?? "cli",
    );
    // The role badge in thread metadata mirrors the row — clear it so
    // the UI stops showing the old role («Без плагина»).
    if (deps.threads.updatePluginMetadata) {
      await deps.threads
        .updatePluginMetadata({
          threadId: input.threadId,
          remove: ["role"],
        })
        .catch((e) =>
          deps.log?.warn?.(
            `orchestrator: role badge clear: ${describeErr(e)}`,
          ),
        );
    }
    return { threadId: input.threadId, role: input.role, previous };
  });
}

export const describeErr = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// ── Helper watchdog (§19.1 table + cascades) ─────────────────────────

export interface HelperWatchdogDeps extends HelperDeps {
  /** §19.1 outcomes: the caller gets exactly one line per terminal
   * outcome — the `notified_at` mark dedupes restarts. */
  callerSend(threadId: string, text: string): Promise<unknown>;
}

export function createHelperWatchdog(deps: HelperWatchdogDeps) {  /** In-memory once-per-process marks — `notified_at` covers the
   * restart-durable terminal lines; an approval reminder may repeat
   * once after a plugin restart (bounded, harmless). */
  const approvalReminded = new Set<number>();
  const row = (id: number) => deps.store.helper(id);
  const t = () => deps.t;
  const now = () => deps.now?.() ?? Date.now();

  /** §19.1: the one terminal line per outcome — the atomic
   * `notified_at` write decides who sends, so a racing notification
   * path can never double the line. */
  const notifyOnce = async (r: HelperRow, text: string) => {
    if (!deps.store.setHelperNotifiedIf(r.id, now())) return;
    await deps.callerSend(r.caller_thread_id, text).catch((e) =>
      deps.log?.warn?.(
        `orchestrator: helper#${r.id} notice: ${describeErr(e)}`,
      ),
    );
  };

  /** §19.1 terminal outcome — the atomic status flip first (a racing
   * handler loses and returns), then `threads.stop` for the non-done
   * outcomes: a released helper must not keep editing the caller's
   * reused environment. `done` leaves the thread for the janitor —
   * stopping it could swallow BB's parent notification. */
  const finish = async (
    r: HelperRow,
    status: "done" | "failed" | "stalled" | "quota" | "cancelled",
    text?: string,
  ) => {
    if (!deps.store.setHelperTerminal(r.id, status)) return;
    if (status !== "done" && r.thread_id) {
      await deps.threads.stop({ threadId: r.thread_id }).catch((e) =>
        deps.log?.warn?.(
          `orchestrator: helper#${r.id} stop: ${describeErr(e)}`,
        ),
      );
    }
    if (text) await notifyOnce({ ...r, status }, text);
  };

  const cancelRow = async (r: HelperRow) => {
    if (!deps.store.setHelperTerminal(r.id, "cancelled")) return;
    if (r.thread_id) {
      await deps.threads
        .stop({ threadId: r.thread_id })
        .catch(() => undefined);
    }
  };

  /** §19.1 cascade: every active helper of a caller that left its
   * running state — archive/delete or a delegation outcome — is
   * cancelled. */
  const cancelHelpersOfCaller = async (callerThreadId: string) => {
    for (const r of deps.store.activeHelpersByCaller(callerThreadId)) {
      await cancelRow(r);
    }
  };
  const cancelHelpersOfDelegation = async (delegationId: number) => {
    for (const r of deps.store.activeHelpersByDelegation(delegationId)) {
      await cancelRow(r);
    }
  };

  /** §19.1 dispatching reconcile: find the child by
   * `pluginMetadata.helperId` among the caller's children; link it and
   * finish setup — or stop it when the row was cancelled meanwhile. */
  const tryRelink = async (r: HelperRow): Promise<boolean> => {
    let children: { id: string }[] = [];
    try {
      children = await deps.threads.list({
        parentThreadId: r.caller_thread_id,
        includeHidden: true,
        limit: 50,
      });
    } catch {
      return false;
    }
    for (const c of children) {
      let meta: Record<string, unknown> | null | undefined;
      try {
        meta = await deps.threads.getPluginMetadata?.({ threadId: c.id });
      } catch {
        continue;
      }
      if (meta?.helperId !== r.id) continue;
      if (!HELPER_ACTIVE.has(r.status)) {
        await deps.threads.stop({ threadId: c.id }).catch(() => undefined);
        return true;
      }
      deps.store.setHelperThread(r.id, c.id);
      deps.store.setThreadRole(c.id, "helper", "delegate");
      deps.store.setHelperTurnStarted(r.id, now());
      deps.store.setHelperStatusIf(r.id, "dispatching", "running");
      return true;
    }
    return false;
  };

  /** §19.1: the turn's tail, newest first, up to `turn_started_at` —
   * same reading as the delegation watchdog's `lastTurnError`. */
  type TailVerdict =
    | { kind: "done" }
    | { kind: "error"; text: string }
    | { kind: "interrupted" }
    | { kind: "manual-stop" }
    | { kind: "in-flight" }
    | null; // journal unreadable — unknown is not "clean"

  const tailErrorText = (data: Record<string, unknown>): string | null => {
    const parts = [
      data.message,
      data.detail,
      data.code,
      (data.error as { message?: unknown } | undefined)?.message,
      (data.errorInfo as { message?: unknown } | undefined)?.message,
      (data.errorInfo as { category?: unknown } | undefined)?.category,
    ].filter((s): s is string => typeof s === "string" && s.length > 0);
    return parts.length ? parts.join(": ") : null;
  };

  const RESPONSE_TYPES = new Set([
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "item/toolCall/progress",
    "item/mcpToolCall/progress",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
  ]);

  const helperTurnTail = async (r: HelperRow): Promise<TailVerdict> => {
    if (!r.thread_id) return { kind: "in-flight" };
    let events: HelperThreadEvent[];
    try {
      events = await deps.threads.events.list({
        threadId: r.thread_id,
        order: "desc",
        limit: "50",
      });
    } catch (e) {
      deps.log?.warn?.(
        `orchestrator: helper#${r.id} events.tail: ${describeErr(e)}`,
      );
      return null;
    }
    const tail: HelperThreadEvent[] = [];
    for (const ev of events) {
      if (r.turn_started_at != null && ev.createdAt < r.turn_started_at) {
        break; // older turns are out of scope
      }
      if (ev.type === "turn/started") break;
      tail.push(ev);
    }
    const completed = tail.find((e) => e.type === "turn/completed");
    if (completed) {
      const data = (completed.data ?? {}) as Record<string, unknown>;
      const errText =
        tailErrorText(
          (data.error as Record<string, unknown> | undefined) ?? {},
        ) ?? tailErrorText(data);
      if (data.status === "failed" || data.error != null) {
        return {
          kind: "error",
          text: errText ?? `turn/completed: status ${String(data.status)}`,
        };
      }
      return { kind: "done" };
    }
    for (const ev of tail) {
      const data = (ev.data ?? {}) as Record<string, unknown>;
      if (ev.type === "turn.failed" || ev.type === "turn/failed") {
        return { kind: "error", text: tailErrorText(data) ?? "turn failed" };
      }
      if (ev.type === "provider/error" || ev.type === "system/error") {
        // `willRetry` — the provider is still retrying; no verdict yet.
        if (data.willRetry === true) return { kind: "in-flight" };
        return { kind: "error", text: tailErrorText(data) ?? ev.type };
      }
      if (ev.type === "system/thread/interrupted") {
        return data.reason === "manual-stop"
          ? { kind: "manual-stop" }
          : { kind: "interrupted" };
      }
      if (ev.type === "item/started" || ev.type === "item/completed") {
        const item = data.item as { type?: unknown } | undefined;
        if (item?.type !== "userMessage") return { kind: "in-flight" };
        continue;
      }
      if (RESPONSE_TYPES.has(ev.type)) return { kind: "in-flight" };
    }
    return { kind: "in-flight" };
  };

  /** §19.1 `interrupted`: exactly one continuation; a second
   * interruption is `failed` (NOT stalled — the review correction). */
  const resumeHelper = async (r: HelperRow) => {
    if (r.resume_count >= 1) {
      await finish(
        r,
        "failed",
        t()("wd.helperInterrupted2", { id: r.id }),
      );
      return;
    }
    deps.store.bumpHelperResume(r.id);
    deps.store.setHelperTurnStarted(r.id, now());
    await deps.threads
      .send({
        threadId: r.thread_id!,
        mode: "queue-if-active",
        input: [
          { type: "text", text: t()("wd.helperResume"), mentions: [] },
        ],
      })
      .catch((e) =>
        deps.log?.warn?.(
          `orchestrator: helper#${r.id} resume: ${describeErr(e)}`,
        ),
      );
  };

  /** The idle-thread outcome — shared by `onThreadIdle` and the
   * reconcile pass: the journal decides done / error / interruption. */
  const idleOutcome = async (r: HelperRow) => {
    const verdict = await helperTurnTail(r);
    if (verdict === null || verdict.kind === "in-flight") return;
    if (verdict.kind === "done") {
      deps.store.clearHelperTurn(r.id);
      await finish(r, "done");
      return;
    }
    if (verdict.kind === "interrupted") {
      await resumeHelper(r);
      return;
    }
    if (verdict.kind === "manual-stop") {
      await finish(
        r,
        "cancelled",
        t()("wd.helperRemoved", { id: r.id, kind: "stopped" }),
      );
      return;
    }
    const quota = QUOTA_TEXT.test(verdict.text);
    await finish(
      r,
      quota ? "quota" : "failed",
      t()(quota ? "wd.helperQuota" : "wd.helperFailed", {
        id: r.id,
        detail: verdict.text.slice(0, 200),
      }),
    );
  };

  /** The failed-thread outcome — shared by `onThreadFailed` and the
   * reconcile pass: the journal error text (or the event's message)
   * classifies quota vs failed. */
  const failedOutcome = async (r: HelperRow, hint?: string) => {
    const verdict = await helperTurnTail(r);
    const text =
      verdict?.kind === "error"
        ? verdict.text
        : hint ?? "thread failed";
    const quota = QUOTA_TEXT.test(text);
    await finish(
      r,
      quota ? "quota" : "failed",
      t()(quota ? "wd.helperQuota" : "wd.helperFailed", {
        id: r.id,
        detail: text.slice(0, 200),
      }),
    );
  };

  return {
    cancelHelpersOfCaller,
    cancelHelpersOfDelegation,

    /** Helper thread went idle — the journal decides: a clean
     * `turn/completed` is `done` (BB's parent notification carries the
     * result, no plugin line), an error tail is `failed`/`quota`, an
     * interruption gets the one continuation. A plain idle after an
     * error must NOT read as `done` (§19.1). */
    onThreadIdle: async (thread: { id: string; status?: string | null }) => {
      const r = deps.store.helperByThreadId(thread.id);
      if (!r || !HELPER_ACTIVE.has(r.status)) return;
      if (thread.status !== "idle") return;
      await idleOutcome(r);
    },

    onThreadActive: async (thread: { id: string }) => {
      const r = deps.store.helperByThreadId(thread.id);
      if (r && HELPER_ACTIVE.has(r.status) && r.turn_started_at === null) {
        deps.store.setHelperTurnStarted(r.id, now());
      }
    },

    /** thread.failed → `failed` (a quota-shaped error → `quota`) —
     * the journal tail classifies; the thread is stopped so it cannot
     * keep editing the caller's environment. */
    onThreadFailed: async (
      thread: { id: string },
      error?: { message?: string },
    ) => {
      const r = deps.store.helperByThreadId(thread.id);
      if (!r || !HELPER_ACTIVE.has(r.status)) return;
      await failedOutcome(r, error?.message);
    },

    /** §19.1 `turn.failed` — the typed signal first
     * (`errorInfo.category` rate-limit/billing → `quota`); without a
     * typed cause the journal decides between the one interruption
     * continuation and `failed`. */
    onTurnFailed: async (event: {
      threadId: string;
      errorInfo?: { category?: string | null } | null;
      inputAccepted?: boolean;
    }) => {
      const r = deps.store.helperByThreadId(event.threadId);
      if (!r || !HELPER_ACTIVE.has(r.status) || !r.thread_id) return;
      const category = event.errorInfo?.category;
      if (typeof category === "string" && QUOTA_CATEGORIES.has(category)) {
        await finish(
          r,
          "quota",
          t()("wd.helperQuota", {
            id: r.id,
            detail: `turn failed (${category})`,
          }),
        );
        return;
      }
      const verdict = await helperTurnTail(r);
      if (verdict?.kind === "interrupted") {
        await resumeHelper(r);
        return;
      }
      if (verdict?.kind === "manual-stop") {
        await finish(
          r,
          "cancelled",
          t()("wd.helperRemoved", { id: r.id, kind: "stopped" }),
        );
        return;
      }
      const detail =
        verdict?.kind === "error"
          ? verdict.text
          : category
            ? `turn failed (${category})`
            : event.inputAccepted === false
              ? "turn failed (input refused)"
              : "turn failed";
      const quota = QUOTA_TEXT.test(detail);
      await finish(
        r,
        quota ? "quota" : "failed",
        t()(quota ? "wd.helperQuota" : "wd.helperFailed", {
          id: r.id,
          detail: detail.slice(0, 200),
        }),
      );
    },

    /** §19.1 `approval`: one reminder line to the caller. */
    onInteractionPending: async (thread: { id: string }) => {
      const r = deps.store.helperByThreadId(thread.id);
      if (!r || !HELPER_ACTIVE.has(r.status)) return;
      if (approvalReminded.has(r.id)) return;
      approvalReminded.add(r.id);
      await deps
        .callerSend(
          r.caller_thread_id,
          t()("wd.helperApproval", { id: r.id }),
        )
        .catch(() => undefined);
    },

    /** §19.1 cascades on archive/delete: a helper thread that vanished
     * is `cancelled` + one «removed manually» line; a gone caller cancels
     * ALL its active helpers. */
    onThreadGone: async (thread: { id: string }, kind: string) => {
      const r = deps.store.helperByThreadId(thread.id);
      if (r && HELPER_ACTIVE.has(r.status)) {
        await finish(
          r,
          "cancelled",
          t()("wd.helperRemoved", { id: r.id, kind }),
        );
      }
      await cancelHelpersOfCaller(thread.id);
    },

    /** Silence + dispatch-grace checks on the short beat. The silence
     * threshold is the helper's OWN route `firstResponseSeconds` (the
     * level's resolved route), not one shared constant. */
    checkTimers: async () => {
      const nowMs = now();
      const load = await deps
        .loadPolicy()
        .catch(() => ({ policy: null }) as PolicyLoad);
      const firstMsOf = (r: HelperRow) =>
        ((r.route ? findRoute(load.policy, r.route)?.firstResponseSeconds : undefined) ??
          load.policy?.firstResponseSeconds ??
          60) * 1000;
      for (const r of deps.store.listActiveHelpers()) {
        if (
          r.status === "dispatching" &&
          !r.thread_id &&
          nowMs - r.created_at > HELPER_DISPATCH_GRACE_MS
        ) {
          await finish(
            r,
            "failed",
            t()("wd.helperDispatchLost", { id: r.id }),
          );
          continue;
        }
        if (r.status !== "running" || r.turn_started_at === null) continue;
        // Silence: no journal events since `turn_started_at` (which the
        // last-seen event time refreshes below — a direct write, so a
        // busy helper's clock follows its last event).
        let latest = r.turn_started_at;
        try {
          const events = await deps.threads.events.list({
            threadId: r.thread_id!,
            afterSeq: r.last_seq ?? undefined,
            limit: 50,
          });
          if (events.length) {
            const last = events[events.length - 1]!;
            deps.store.advanceHelperLastSeq(r.id, last.seq);
            latest = Math.max(latest, last.createdAt);
            deps.store.setHelperTurnStarted(r.id, latest);
            continue;
          }
        } catch {
          continue;
        }
        if (nowMs - latest > firstMsOf(r)) {
          await finish(
            r,
            "stalled",
            t()("wd.helperStalled", { id: r.id }),
          );
        }
      }
    },

    /** The 60 s reconcile: relink dispatching rows AND cancelled rows
     * still lacking `thread_id` (the «отмена до thread_id» case — the
     * surfaced child is stopped), judge helpers by their thread's live
     * state (idle → the journal outcome, error → failed, gone → the
     * cascades), run the caller/delegation cascades, archive terminal
     * helpers after 24 h (marked rows only — never re-archived). */
    reconcile: async () => {
      const nowMs = now();
      const errors: string[] = [];
      for (const r of deps.store.listUnlinkedHelpers()) {
        try {
          await tryRelink(r);
        } catch (e) {
          errors.push(`helper#${r.id} relink: ${describeErr(e)}`);
        }
      }
      for (const r of deps.store.listActiveHelpers()) {
        try {
          if (r.thread_id && r.status === "running") {
            const thread = await deps.threads
              .get({ threadId: r.thread_id })
              .catch(() => undefined);
            if (!thread) {
              await finish(
                r,
                "failed",
                t()("wd.helperGone", { id: r.id }),
              );
            } else if (thread.archivedAt || thread.deletedAt) {
              await finish(
                r,
                "cancelled",
                t()("wd.helperRemoved", {
                  id: r.id,
                  kind: thread.deletedAt ? "deleted" : "archived",
                }),
              );
            } else if (thread.status === "idle") {
              await idleOutcome(r);
            } else if (
              thread.status === "error" ||
              thread.status === "failed"
            ) {
              await failedOutcome(r);
            }
          }
          // Cascades: the caller delegation left `running`, or the
          // caller thread vanished.
          const fresh = row(r.id);
          if (fresh && HELPER_ACTIVE.has(fresh.status)) {
            if (fresh.caller_delegation_id !== null) {
              const d = deps.store.get(fresh.caller_delegation_id);
              if (
                !d ||
                (d.status !== "running" && d.status !== "dispatching")
              ) {
                await cancelRow(fresh);
                continue;
              }
            }
            const caller = await deps.threads
              .get({ threadId: fresh.caller_thread_id })
              .catch(() => undefined);
            if (!caller || caller.archivedAt || caller.deletedAt) {
              await cancelHelpersOfCaller(fresh.caller_thread_id);
            }
          }
        } catch (e) {
          errors.push(`helper#${r.id}: ${describeErr(e)}`);
        }
      }
      // §19.6: terminal helpers' threads archived after 24 h — the
      // `archived_at` mark keeps the pass from re-archiving every beat.
      if (deps.threads.archive) {
        for (const r of deps.store.listHelpersForArchive(
          nowMs - HELPER_ARCHIVE_AFTER_MS,
        )) {
          const archived = await deps.threads
            .archive({ threadId: r.thread_id! })
            .then(() => true)
            .catch(() => false);
          if (archived) deps.store.markHelperArchived(r.id);
        }
      }
      return { errors };
    },
  };
}
