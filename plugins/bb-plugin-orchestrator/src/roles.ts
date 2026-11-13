/**
 * Agent roles (spec §13): the three MVP roles — `orchestrator` (default),
 * `executor`, `auditor` — as plugin constants: instruction text (≤ 2500
 * characters each, the §3 budget), the `delegates` flag that decides the
 * §3 coordinator question, and the role's plugin tools and skills.
 *
 * The role binding lives in `thread_roles` (source of truth); the new-chat
 * window's current pick lives in `pending_roles`. The `message.dispatch`
 * hook decides the role once, on a thread's first message; `configure`
 * only reads it. Everything here is synchronous and allocation-free to
 * call — the hook runs under the server-wide dispatch lock.
 */

import type {
  MessageDispatchHookContext,
  MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import { levelRole, type Policy, type PolicyIssue } from "./policy.js";
import { T_RU, type T } from "./i18n/index.js";

/** §3 budget: one role instruction ≤ 2500 chars (role + rule ≤ 4096). */
export const ROLE_INSTRUCTIONS_MAX = 2500;

/** §18.6: the handoff file path in the default role texts — the
 * `handoffPath` setting substitutes it. */
export const DEFAULT_HANDOFF_PATH = "$BB_THREAD_STORAGE/HANDOFF.md";

/** §18.6: `handoffPath` is one line of at most 256 characters. */
export const HANDOFF_PATH_MAX = 256;

/**
 * §18.6: validation error for `handoffPath`, or null when the value is
 * usable (empty falls back to DEFAULT_HANDOFF_PATH). The setting schema
 * refuses bad writes; this catches values that bypassed it.
 */
export function handoffPathError(
  text: string | undefined,
  t: T = T_RU,
): string | null {
  if (text === undefined) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/[\r\n]/.test(trimmed)) return t("role.handoffOneLine");
  return trimmed.length > HANDOFF_PATH_MAX
    ? t("role.handoffTooLong", {
        max: HANDOFF_PATH_MAX,
        len: trimmed.length,
      })
    : null;
}

/** §18.6: the review level's name in the orchestrator text without a
 * policy (and when the policy declares no auditor level). */
export const DEFAULT_REVIEW_LEVEL = "review";

export type RoleId =
  | "orchestrator"
  | "executor"
  | "auditor"
  | "release-auditor";

export const ROLE_IDS: readonly RoleId[] = [
  "orchestrator",
  "executor",
  "auditor",
  "release-auditor",
];

/** §13.1 rev 20: `release-auditor` is never offered in the new-chat
 * window — only a `release` pipeline dispatch assigns it (source
 * `delegate`). The RPC enum and the composer list use this subset. */
export const PICKABLE_ROLE_IDS = [
  "orchestrator",
  "executor",
  "auditor",
] as const;

export const DEFAULT_ROLE: RoleId = "orchestrator";

export interface RoleDefinition {
  id: RoleId;
  /** §13.1: may this role hand work out — the §3 coordinator question. */
  delegates: boolean;
  instructions: string;
  tools: readonly string[];
  skills: readonly string[];
}

/**
 * §18.6: role texts are composed — the BODY (with `{handoff}` and
 * `{review}` substitutions, `roleTexts` may append to it) plus the
 * MANDATORY tail the plugin always adds itself: the sudo/packages/host
 * ban (§17.1) on doers and the JSON verdict line (r31) on `auditor`.
 * The user cannot remove the mandatory parts via `roleTexts`.
 * `release-auditor` is not customizable at all.
 */
const ROLE_BODY_KEYS: Record<RoleId, string> = {
  orchestrator: "role.body.orchestrator",
  executor: "role.body.executor",
  auditor: "role.body.auditor",
  "release-auditor": "role.body.releaseAuditor",
};

const ROLE_MANDATORY_KEYS: Partial<Record<RoleId, string>> = {
  orchestrator: "role.mand.orchestrator",
  executor: "role.mand.executor",
  auditor: "role.mand.auditor",
};

/**
 * §18.6: the effective instruction text — body with `{handoff}`/`{review}`
 * substituted, the optional `roleTexts` addition, and the mandatory tail
 * LAST so no `roleTexts` value can remove it.
 */
export function roleInstructions(
  id: RoleId,
  opts?: {
    /** The `roleTexts` addition for this role (trimmed). */
    extra?: string | undefined;
    /** The `handoffPath` setting; default DEFAULT_HANDOFF_PATH. */
    handoffPath?: string | undefined;
    /** The review level's name from the policy (orchestrator text). */
    reviewLevel?: string | undefined;
    /** §18.1: the language catalog (defaults to T_RU). */
    t?: T | undefined;
  },
): string {
  const t = opts?.t ?? T_RU;
  const body = t(ROLE_BODY_KEYS[id]!, {
    handoff: opts?.handoffPath ?? DEFAULT_HANDOFF_PATH,
    review: opts?.reviewLevel ?? DEFAULT_REVIEW_LEVEL,
  });
  // §18.6: `release-auditor` is not customizable — `roleTexts` keys are
  // rejected at parse, and the composer ignores an addition here too.
  const extra =
    id === "release-auditor" ? undefined : opts?.extra?.trim();
  const mandatoryKey = ROLE_MANDATORY_KEYS[id];
  const mandatory = mandatoryKey ? t(mandatoryKey) : undefined;
  return (
    body +
    (extra ? `\n${extra}` : "") +
    (mandatory ? `\n${mandatory}` : "")
  );
}

/**
 * §18.6: the review level's name in the orchestrator text — `review`
 * when the policy declares it, else the first auditor level (never the
 * pipeline's `release-audit`), else the literal default.
 */
export function reviewLevelName(
  policy: Policy | null | undefined,
): string {
  if (policy) {
    if (
      policy.levels["review"] &&
      levelRole(policy, "review") === "auditor"
    ) {
      return "review";
    }
    const alt = Object.keys(policy.levels).find(
      (n) => n !== "release-audit" && levelRole(policy, n) === "auditor",
    );
    if (alt) return alt;
  }
  return DEFAULT_REVIEW_LEVEL;
}

/** The roles `roleTexts` may add text to — `release-auditor` excluded. */
export type CustomizableRoleId = (typeof PICKABLE_ROLE_IDS)[number];

export interface RoleTextsLoad {
  /** The per-role additions; EMPTY whenever `errors` is non-empty — a
   * malformed document is ignored whole, never partially applied. */
  texts: Partial<Record<CustomizableRoleId, string>>;
  errors: PolicyIssue[];
}

/**
 * §18.6: the `roleTexts` setting — a JSON object whose only keys are
 * `orchestrator`, `executor`, `auditor`; each value is appended to that
 * role's text (the mandatory parts always come after it). An addition
 * that pushes the composed text over the §3 2500-char budget is an
 * error, as is any other key.
 */
export function parseRoleTexts(
  text: string | undefined,
  opts?: {
    /** §18.6: the REAL `handoffPath`/`reviewLevel` substitutions — the
     * 2500-char limit is checked on the composed text with them, not
     * the defaults. */
    handoffPath?: string | undefined;
    reviewLevel?: string | undefined;
    /** §18.1: parse errors — the language catalog. */
    t?: T;
  },
): RoleTextsLoad {
  const t = opts?.t ?? T_RU;
  const errors: PolicyIssue[] = [];
  const texts: RoleTextsLoad["texts"] = {};
  const done = (): RoleTextsLoad => ({ texts: {}, errors });
  if (!text || text.trim() === "") return { texts, errors };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    errors.push({
      path: "$",
      message: t("role.badJson", { error: (e as Error).message }),
    });
    return done();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push({ path: "$", message: t("role.notObject") });
    return done();
  }
  for (const [key, value] of Object.entries(raw)) {
    const path = `roleTexts.${key}`;
    if (
      !(PICKABLE_ROLE_IDS as readonly string[]).includes(key)
    ) {
      errors.push({
        path,
        message: t("role.badKeys"),
      });
      continue;
    }
    if (typeof value !== "string") {
      errors.push({ path, message: t("role.mustBeString") });
      continue;
    }
    const extra = value.trim();
    if (!extra) continue;
    if (
      roleInstructions(key as RoleId, {
        extra,
        handoffPath: opts?.handoffPath,
        reviewLevel: opts?.reviewLevel,
        t,
      }).length > ROLE_INSTRUCTIONS_MAX
    ) {
      errors.push({
        path,
        message: t("role.tooLong", { max: ROLE_INSTRUCTIONS_MAX }),
      });
      continue;
    }
    texts[key as CustomizableRoleId] = extra;
  }
  return errors.length ? done() : { texts, errors };
}

/** The needs-configuration line for a broken `roleTexts` document —
 * like `gitInstructionsError` the value is ignored until fixed. */
export function roleTextsError(
  load: RoleTextsLoad,
  t: T = T_RU,
): string | null {
  const first = load.errors[0];
  return first
    ? t("role.textsError", { path: first.path, message: first.message })
    : null;
}

export const ROLES: Record<RoleId, RoleDefinition> = {
  orchestrator: {
    id: "orchestrator",
    delegates: true,
    instructions: roleInstructions("orchestrator"),
    tools: [
      "orchestrator_delegate",
      "orchestrator_status",
      "orchestrator_cancel",
      "orchestrator_merge",
    ],
    skills: ["orchestrator-coordinator", "orchestrator-setup"],
  },
  executor: {
    id: "executor",
    delegates: false,
    instructions: roleInstructions("executor"),
    tools: [],
    skills: [],
  },
  auditor: {
    id: "auditor",
    delegates: false,
    instructions: roleInstructions("auditor"),
    tools: [],
    skills: [],
  },
  "release-auditor": {
    id: "release-auditor",
    delegates: false,
    instructions: roleInstructions("release-auditor"),
    tools: [],
    skills: [],
  },
};

export const isRoleId = (value: unknown): value is RoleId =>
  typeof value === "string" && (ROLE_IDS as readonly string[]).includes(value);

/**
 * §4 step 4 + §13.2 + §2.3: a delegated thread's role from the dispatch
 * level — `release-audit` (the release pipeline's checking agent) maps to
 * `release-auditor`, a level with role `auditor` (or the historical bare
 * `review`) to `auditor`, every other level to `executor`. Without the
 * policy (tests, missing level) the name rule applies.
 */
export const roleForLevel = (
  level: string,
  policy?: Policy | null,
): RoleId =>
  level === "release-audit"
    ? "release-auditor"
    : levelRole(policy, level) === "auditor"
      ? "auditor"
      : "executor";

/** Dispatch titles carry the task key from birth: `<KEY> · <title>`. */
const TASK_KEY_TITLE_RE = /^([A-Z][A-Z0-9]+-\d+) · /;

export const taskKeyFromTitle = (title: string | null): string | null =>
  title ? TASK_KEY_TITLE_RE.exec(title)?.[1] ?? null : null;

/** The §13.2 п.2 hook inputs, already flattened from the hook context. */
export interface RoleDecisionFacts {
  threadId: string;
  /** `thread.status` — only a `"pending"` thread is still undecided. */
  status: string | null;
  originPluginId: string | null;
  title: string | null;
  sourceThreadId: string | null;
  parentThreadId: string | null;
  /** `attempt` — `"start-turn"` only; join-turn is never a first message. */
  attempt: string;
  /** `origin` — `"app"` names a thread born in the new-chat window. */
  origin: string | null;
  projectId: string;
}

/**
 * Synchronous SQLite reads only — the hook forbids CLI, network and await.
 * `threadRole` doubles as the "already decided" check and the side-chat
 * source lookup.
 */
export interface RoleDecisionProbes {
  threadRole(threadId: string): { role: string } | undefined;
  pendingRole(projectId: string): string | undefined;
  activeDelegationByTaskKey(taskKey: string): { level: string } | undefined;
  /**
   * The live parsed policy (in-memory, sync — the hook may not call out).
   * Drives the §2.3 level→role map; `null` while the policy is invalid
   * (§16.7: a root chat then gets no role — only the setup skill).
   * Absent probe = behave as before (valid, name-based role mapping).
   */
  policy?(): Policy | null;
  /**
   * §17.1 r26 (PLUG-211 Б2): plugin ids whose threads continue a human
   * chat (session handoff, chat compaction into a new thread) — their
   * thread inherits the source role, or takes the orchestrator default
   * without a decidable source. Absent probe = the default
   * `["handoff", "external-compact"]`.
   */
  userThreadPlugins?(): readonly string[];
}

/** §17.1: the recorded "no orchestrator role" verdict for plugin-/sdk-
 * born threads — the row keeps the §3 fallback criterion from issuing
 * coordinator tools to them at `configure` (audit Б3). */
export const NO_ROLE = "none";

/** §17.1 r32 (§18.6): plugins continuing a human chat when the
 * `userThreadPlugins` setting is unset — EMPTY for a new installation;
 * an existing one keeps `handoff, external-compact` (or its own list)
 * in the explicit setting value. */
export const DEFAULT_USER_THREAD_PLUGINS: readonly string[] = [];

/**
 * §13.2 п.2 — the role rule, evaluated strictly in the spec's branch order.
 * Returns `null` when this dispatch is not the thread's first message (or
 * the role is already recorded) and nothing may be written.
 */
export function decideRole(
  facts: RoleDecisionFacts,
  probes: RoleDecisionProbes,
): RoleId | typeof NO_ROLE | null {
  if (facts.attempt !== "start-turn") return null;
  if (facts.status !== "pending") return null;
  if (probes.threadRole(facts.threadId)) return null;

  // §16.7: while the policy is invalid a root chat gets no role.
  const policyOk =
    probes.policy === undefined || probes.policy() !== null;
  // §17.1 r26 (PLUG-211 Б2): plugins that continue a human chat.
  const userPlugins =
    probes.userThreadPlugins?.() ?? DEFAULT_USER_THREAD_PLUGINS;

  // 1. A thread created by `bb tasks dispatch` — or spawned by this
  //    plugin itself (§4 r30 д: `originPluginId = "orchestrator"`) — is an
  //    executor; its level decides auditor vs executor.
  if (
    facts.originPluginId === "tasks" ||
    facts.originPluginId === "orchestrator"
  ) {
    const key = taskKeyFromTitle(facts.title);
    const row = key ? probes.activeDelegationByTaskKey(key) : undefined;
    return row ? roleForLevel(row.level, probes.policy?.()) : "executor";
  }
  // 2. A side chat / session handoff inherits the source thread's role;
  //    no recorded source role — keep walking the rule.
  if (facts.sourceThreadId) {
    const source = probes.threadRole(facts.sourceThreadId);
    if (source && isRoleId(source.role)) return source.role;
  }
  // 3. Any other child thread executes. §17.1 r26 (PLUG-215 С2): the
  //    parent rule beats userThreadPlugins — a user-continuation
  //    plugin's thread WITH a parent is a handed-off worker, not a
  //    human chat.
  if (facts.parentThreadId) return "executor";
  // §17.1 r26 (PLUG-211 Б2): a user-continuation plugin's thread IS a
  //    human chat — the source's role already applied when decidable;
  //    without it the thread gets the orchestrator default, like a chat
  //    opened from the window (`policyOk` gates it the same way).
  if (facts.originPluginId && userPlugins.includes(facts.originPluginId)) {
    return policyOk ? DEFAULT_ROLE : null;
  }
  // 4. A chat from the new-thread window takes the project's current pick.
  //    §16.7: while the policy is invalid the DEFAULT is no role — an
  //    explicit pick still applies, the setup skill alone is issued.
  if (facts.origin === "app") {
    const pending = probes.pendingRole(facts.projectId);
    // §16.7 (PLUG-182): the new-chat window writes `orchestrator` itself
    // on open — while the policy is invalid that pick is the default, not
    // a choice, so the thread stays role-less (setup skill only). Other
    // picks are real choices and still apply.
    if (
      pending !== undefined &&
      isRoleId(pending) &&
      (policyOk || pending !== DEFAULT_ROLE)
    ) {
      return pending;
    }
    return policyOk ? DEFAULT_ROLE : null;
  }
  // 5. §17.1 (аудит Б3): the default orchestrator role is for threads a
  //    human or an agent opened — `app` above (the new-chat window) and
  //    `cli` (`bb thread spawn`) here. Plugin-, sdk- and automation-born
  //    threads (advisor, live-call, perspectives, …) get NO role: no
  //    dispatch tools, no coordinator instructions. The recorded `none`
  //    row is what stops the §3 fallback criterion from handing them the
  //    coordinator issuance at `configure`.
  if (facts.origin === "cli") return policyOk ? DEFAULT_ROLE : null;
  return NO_ROLE;
}

/**
 * The `message.dispatch` hook itself (§13.2 п.2). Fail-closed by the SDK —
 * a throw or a >10 s answer fails the attempt, and the pass runs under one
 * server lock — so the handler answers "proceed" on every path and touches
 * only synchronous SQLite: no CLI, no network, no `await`. `record` writes
 * the decided row (`source = hook`); display metadata is not written here —
 * it rides on the next `configure` (§13.2 п.4).
 */
export function handleMessageDispatch(
  context: MessageDispatchHookContext,
  probes: RoleDecisionProbes,
  record: (threadId: string, role: RoleId | typeof NO_ROLE) => void,
  warn?: (message: string) => void,
): MessageDispatchHookDecision {
  try {
    const role = decideRole(
      {
        threadId: context.thread.id,
        status: context.thread.status,
        originPluginId: context.thread.originPluginId,
        title: context.thread.title ?? context.thread.titleFallback,
        sourceThreadId: context.thread.sourceThreadId,
        parentThreadId: context.thread.parentThreadId,
        attempt: context.attempt,
        origin: context.origin,
        projectId: context.project.id,
      },
      probes,
    );
    if (role) record(context.thread.id, role);
  } catch (e) {
    warn?.(e instanceof Error ? e.message : String(e));
  }
  return { action: "proceed" };
}
