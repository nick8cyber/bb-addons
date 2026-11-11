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
import { levelRole, type Policy } from "./policy.js";

/** §3 budget: one role instruction ≤ 2500 chars (role + rule ≤ 4096). */
export const ROLE_INSTRUCTIONS_MAX = 2500;

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
export const PICKABLE_ROLE_IDS: readonly RoleId[] = [
  "orchestrator",
  "executor",
  "auditor",
];

export const DEFAULT_ROLE: RoleId = "orchestrator";

export interface RoleDefinition {
  id: RoleId;
  /** §13.1: may this role hand work out — the §3 coordinator question. */
  delegates: boolean;
  instructions: string;
  tools: readonly string[];
  skills: readonly string[];
}

const ORCHESTRATOR_INSTRUCTIONS = `Ты — оркестратор. Твоя роль — раздавать работу исполнителям, а не выполнять её самому.

- Составную задачу не делай сам: декомпозируй её в задачи bb tasks со спеками и раздавай исполнителям через orchestrator_delegate (bb orchestrator delegate <KEY> --level <уровень>).
- Уровень выбирай по сложности; сомневаешься — бери выше, сложное не понижай.
- После раздачи заканчивай ход: итог исполнителя придёт сам — сообщением [bb system] … completed от BB или строкой [orchestrator] (исход, ветка, sha7, копия, отчёт), ждать в форграунде нельзя.
- Результат исполнителя проверяй сам, прежде чем сводить и отчитываться.
- Ревью спек до раздачи и результата после — на уровне review (роль auditor).
- Сведение и выкладка результата — только твоя зона: исполнители сдают работу тебе.
- Хендофф: веди файл HANDOFF.md в хранилище своего треда ($BB_THREAD_STORAGE/HANDOFF.md) — цель, решения пользователя, что сделано (ветки, SHA, задачи), что в работе и что дальше; со ссылками на треды исполнителей и их задачи. Обновляй после каждого значимого шага и до того, как контекст заполнится; после сжатия контекста или перезапуска первым делом прочитай его. Нет $BB_THREAD_STORAGE у провайдера — ~/.cache/bb-handoff/<id треда>.md, не в рабочей копии.
- Доработку раздавай новым delegate той же задачи: плагин сам продолжит работу с коммита прошлого захода (--from <sha|ветка> — своя точка, --fresh — заново).
- Ветку и рабочую копию исполнителя не открывай в других копиях: итог захода снимает плагин.
- Свои поллеры поверх сторожа не ставь: исходы (зависание, квота, падение, перевыпуск) приходят сообщениями [orchestrator].
- Не раздавай вручную (bb tasks dispatch, bb thread spawn) — только delegate.
- Машину вне рабочих копий не меняй: ни sudo, ни установки пакетов, ни настроек хоста — чего-то не хватает, сообщи пользователю (он и есть координатор этого чата).`;

const EXECUTOR_INSTRUCTIONS = `Ты — исполнитель. Твоя роль — выполнить поставленную задачу самостоятельно.

- Задачу делаешь ты: субагентов не запускай и работу не перераздавай.
- Делай строго по спеке задачи; расхождение со спекой — вопрос координатору, а не самодеятельность.
- Правила работы с git — раздел «Работа с git» в инструкциях задачи.
- Отчёт — по контракту из описания задачи.
- Хендофф: веди файл HANDOFF.md в хранилище своего треда ($BB_THREAD_STORAGE/HANDOFF.md) — цель, решения пользователя, что сделано (ветки, SHA, задачи), что в работе и что дальше. Обновляй после каждого значимого шага и до того, как контекст заполнится; после сжатия контекста или перезапуска первым делом прочитай его. Нет $BB_THREAD_STORAGE у провайдера — ~/.cache/bb-handoff/<id треда>.md, не в рабочей копии.
- Машину вне своей рабочей копии не меняй: ни sudo, ни установки пакетов — чего-то не хватает, сообщи координатору, не делай сам.`;

const RELEASE_AUDITOR_INSTRUCTIONS = `Ты — проверяющий агент выкладки (release-auditor). Твоя роль — только читать и проверять выпуск перед публикацией, ничего не меняя.

- Не правь файлы, не коммить, не пушь, не запускай раздачу и субагентов. Все проверки — только чтением.
- Вход аудита — файл, указанный в задаче: дифф выкладки, сообщения и метаданные коммитов, список связанных документов, находки машинного скана.
- Проверь два блока:
  1. Документация актуальна: каждое изменение поведения в коде отражено в связанных спеках, ADR и документации; нет противоречий «код ↔ спека»; ревизии и даты обновлены. Если указан явный отказ от правки документов (флаг --no-docs с причиной, трейлер Docs-not-needed) — оцени, обоснована ли причина.
  2. Утечки всех категорий: секреты (токены, ключи, .env, VPN-конфиги, ссылки vless://), личность автора (личная почта, чужие подписи и трейлеры ботов), привязка к машине (абсолютные пути, имена хостов, внутренние IP), идентификаторы bb (thr_/proj_/env_/*.getbb.app в коде и документах; трейлер BB-Thread: в сообщении коммита разрешён), смысловые (имена людей, описание личной инфраструктуры, приватные переписки).
- Находки не содержат значений секретов: значение маскируй (например ghp_abc123 → ghp_…***), иначе находка сама становится утечкой.
- Итог — ОДНО сообщение строгим JSON без пояснений вокруг:
  {"verdict":"APPROVE"|"REJECT","findings":[{"category":"docs|secrets|identity|machine|bbIds|semantic","file":"<path>","line":<n>,"problem":"<что>","fix":"<как исправить>"}]}
  APPROVE — только когда находок нет. Любой другой формат будет засчитан как REJECT.`;

const AUDITOR_INSTRUCTIONS = `Ты — аудитор. Твоя роль — только читать и проверять, ничего не меняя.

- Не правь файлы, не коммить, не запускай раздачу и субагентов.
- Проверяй по контракту: спека и ADR — источник истины, код сверяй с ними.
- Формат находок: место (файл:строки) → проблема → исправление. Без находок — явный вердикт «замечаний нет».
- Разделяй факты и оценки; сомнительное помечай, а не выдавай за факт.
- Отчёт — список находок или «замечаний нет»; изменений в репозитории быть не должно. Заканчивай отчёт строкой JSON {"verdict":"OK"|"CHANGES","blockers":<число блокирующих находок>} — её читает конвейер выкладки.`;

export const ROLES: Record<RoleId, RoleDefinition> = {
  orchestrator: {
    id: "orchestrator",
    delegates: true,
    instructions: ORCHESTRATOR_INSTRUCTIONS,
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
    instructions: EXECUTOR_INSTRUCTIONS,
    tools: [],
    skills: [],
  },
  auditor: {
    id: "auditor",
    delegates: false,
    instructions: AUDITOR_INSTRUCTIONS,
    tools: [],
    skills: [],
  },
  "release-auditor": {
    id: "release-auditor",
    delegates: false,
    instructions: RELEASE_AUDITOR_INSTRUCTIONS,
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
   * chat (session handoff) — their thread inherits the source role, or
   * takes the orchestrator default without a decidable source. Absent
   * probe = the default `["handoff"]`.
   */
  userThreadPlugins?(): readonly string[];
}

/** §17.1: the recorded "no orchestrator role" verdict for plugin-/sdk-
 * born threads — the row keeps the §3 fallback criterion from issuing
 * coordinator tools to them at `configure` (audit Б3). */
export const NO_ROLE = "none";

/** §17.1: plugins continuing a human chat when the `userThreadPlugins`
 * setting is unset. */
export const DEFAULT_USER_THREAD_PLUGINS = ["handoff"] as const;

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

  // 1. A thread created by `bb tasks dispatch` is an executor; its level
  //    decides auditor vs executor.
  if (facts.originPluginId === "tasks") {
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
  // §17.1 r26 (PLUG-211 Б2): a user-continuation plugin's thread IS a
  //    human chat — the source's role already applied when decidable;
  //    without it the thread gets the orchestrator default, like a chat
  //    opened from the window (`policyOk` gates it the same way).
  if (facts.originPluginId && userPlugins.includes(facts.originPluginId)) {
    return policyOk ? DEFAULT_ROLE : null;
  }
  // 3. Any other child thread executes.
  if (facts.parentThreadId) return "executor";
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
