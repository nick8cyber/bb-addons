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
  return `- ${cleanName}${desc ? ` — ${desc}` : ""}`;
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
