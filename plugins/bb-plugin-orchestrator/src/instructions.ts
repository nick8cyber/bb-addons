/**
 * The generated routing rule (spec §3): ≤ 1500 characters built from the
 * policy — levels with descriptions, limits, the `delegate` command, and a
 * pointer to the `orchestrator-coordinator` skill. Printed by
 * `bb orchestrator instructions` and injected into coordinator threads.
 */
import type { Policy } from "./policy.js";

export const ROUTING_RULE_MAX = 1500;

const HEADER =
  "Раздача работы исполнителям — только через `bb orchestrator delegate <KEY> --level <уровень>` " +
  "(инструмент orchestrator_delegate). Полный порядок — навык `orchestrator-coordinator`. " +
  "Отчёт исполнителя придёт сообщением — не жди его в форграунде.";

const FOOTER =
  "Не раздавай исполнителям вручную (`bb tasks dispatch`, `bb thread spawn`) — только delegate.";

/**
 * Policy descriptions are user text: the rule must never leak thread ids or
 * filesystem paths into agent instructions. Only real path-shaped tokens
 * are cut — `~/…`, `./…`, `../…`, `…/…` with 2+ slashes — so inline uses like
 * «фичи/тесты» survive.
 */
const looksLikePath = (token: string): boolean =>
  /^(~|\.\.?)?\//.test(token) || (token.match(/\//g)?.length ?? 0) >= 2;

function sanitize(text: string): string {
  return text
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/thr_[a-z0-9]+/gi, ""))
    .filter((t) => t.length > 0 && !looksLikePath(t))
    .join(" ")
    .trim();
}

function levelLine(name: string, description?: string): string {
  const cleanName = sanitize(name) || "level";
  const desc = description ? sanitize(description) : "";
  // orchestrator §2 rev 20: the pipeline's own level — coordinators
  // never delegate to it, `release` launches it.
  const tag = cleanName === "release-audit" ? " (только конвейер release, не раздавать)" : "";
  return `- ${cleanName}${desc ? ` — ${desc}` : ""}${tag}`;
}

function limitsLine(policy: Policy): string | null {
  const limits = policy.limits;
  if (!limits) return null;
  const parts: string[] = [];
  if (limits.maxActive !== undefined) {
    parts.push(`одновременно активных ≤ ${limits.maxActive}`);
  }
  for (const [level, cap] of Object.entries(limits.perLevel ?? {})) {
    parts.push(`${level} ≤ ${cap}`);
  }
  return parts.length ? `Лимиты: ${parts.join("; ")}.` : null;
}

export function generateRoutingRule(policy: Policy): string {
  const limits = limitsLine(policy);
  const build = (line: (name: string, desc?: string) => string) =>
    [
      HEADER,
      "",
      "Уровни:",
      ...Object.entries(policy.levels).map(([name, l]) =>
        line(name, l.description),
      ),
      ...(limits ? ["", limits] : []),
      "",
      FOOTER,
    ].join("\n");

  let text = build(levelLine);
  if (text.length <= ROUTING_RULE_MAX) return text;
  // Long descriptions: keep the shape, shrink each description.
  const budgetPerLevel = Math.max(
    24,
    Math.floor((ROUTING_RULE_MAX - build((name) => `- ${name}`).length) /
      Math.max(1, Object.keys(policy.levels).length)),
  );
  text = build((name, desc) =>
    levelLine(
      name,
      desc && desc.length > budgetPerLevel
        ? `${desc.slice(0, budgetPerLevel - 1)}…`
        : desc,
    ),
  );
  if (text.length <= ROUTING_RULE_MAX) return text;
  return text.slice(0, ROUTING_RULE_MAX - 1) + "…";
}

/** Shown instead of a rule while the policy is missing or invalid. */
export const SETUP_HINT_TEXT =
  "Плагин orchestrator: политика не настроена или невалидна — delegate отклонит вызовы. " +
  "Настройка — навык `orchestrator-setup`, затем `bb orchestrator policy validate`.";

/**
 * §2.2 — the `gitInstructions` setting: repository git rules for executors,
 * prepended to `--instructions` at every dispatch (delegate and reissue).
 */
export const GIT_INSTRUCTIONS_MAX = 1500;

export const DEFAULT_GIT_INSTRUCTIONS = `Работа с git:
- Первым шагом: git fetch origin и перенос базовой ветки (git merge --ff-only origin/<база>); не вышло — вопрос координатору.
- Работай только в своей рабочей копии и своей ветке; не переключай чужие ветки и не трогай основной чекаут.
- Коммить под автором из конфига репозитория: без --author и git -c user.*; автор не задан — не коммить, напиши в отчёте.
- Без push и PR: локальный коммит, в отчёте ветка и SHA.
- Не запускай git reset --hard, git clean, git checkout -- и другие команды, теряющие чужую работу.
- Обход гейтов запрещён: никаких --no-verify, -c core.hooksPath=…, --author и записи core.hooksPath через git config (в любой области).`;

/**
 * Validation error for `gitInstructions`, or null when the value is usable.
 * The setting schema refuses over-limit writes; this catches values that
 * reached storage before the schema or through another path.
 */
export function gitInstructionsError(text: string | undefined): string | null {
  if (text === undefined) return null;
  return text.length > GIT_INSTRUCTIONS_MAX
    ? `gitInstructions длиннее ${GIT_INSTRUCTIONS_MAX} символов (${text.length})`
    : null;
}

/**
 * §4.1: the «Заход N» section of `--instructions` — tells a continuation
 * round which commit to start from and to leave the previous round's
 * branch and worktree alone.
 */
export function roundSection(
  round: number,
  continueFrom: string,
  branch: string | null | undefined,
): string {
  const prev = branch ?? continueFrom;
  return (
    `Заход ${round}: продолжение работы с коммита ${continueFrom}` +
    ` (ветка ${prev} прошлого захода).\n` +
    `- Первым шагом: git merge --ff-only ${continueFrom}; не fast-forward —` +
    ` git merge --no-edit ${continueFrom}; конфликт — вопрос координатору.\n` +
    `- Ветку прошлого захода не открывай и в её рабочую копию не заходи:` +
    ` работай только в своей ветке.`
  );
}

/**
 * §4.1 r23: auditor levels (read-only roles) get no «Заход N» merge
 * commands — this one line names the commit under review, its branch and
 * the round that produced it. Unknown pieces are dropped (an arbitrary
 * `--from` ref may match no recorded result).
 */
export function reviewRoundLine(
  continueFrom: string,
  branch: string | null | undefined,
  round: number | null | undefined,
): string {
  const parts = [
    ...(branch ? [`ветка ${branch}`] : []),
    ...(round != null ? [`заход ${round}`] : []),
  ];
  return (
    `Проверяемый итог: коммит ${continueFrom}` +
    (parts.length ? ` (${parts.join(", ")})` : "")
  );
}

/**
 * §2.2: the git-rules text becomes the first section of `--instructions`,
 * then the «Заход N» section when the dispatch continues a previous round,
 * then this call's extra instructions; an empty or over-limit value adds
 * no section (an over-limit value is also flagged needs-configuration so it
 * is never silently dropped). No text at all — no `--instructions` flag.
 */
export function mergeDispatchInstructions(
  gitInstructions: string | undefined,
  extra: string | undefined,
  round?: string | undefined,
): string | undefined {
  const git =
    gitInstructionsError(gitInstructions) === null
      ? (gitInstructions ?? "").trim()
      : "";
  const x = (extra ?? "").trim();
  const r = (round ?? "").trim();
  const parts = [
    ...(git ? [git] : []),
    ...(r ? [r] : []),
    ...(x ? [x] : []),
  ];
  return parts.length ? parts.join("\n\n") : undefined;
}

