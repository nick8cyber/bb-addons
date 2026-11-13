/**
 * The generated routing rule (spec §3): ≤ 1500 characters built from the
 * policy — levels with descriptions, limits, the `delegate` command, and a
 * pointer to the `orchestrator-coordinator` skill. Printed by
 * `bb orchestrator instructions` and injected into coordinator threads.
 */
import { levelRole, type Policy } from "./policy.js";
import { EN } from "./i18n/en.js";
import { RU } from "./i18n/ru.js";
import { T_RU, type T } from "./i18n/index.js";

export const ROUTING_RULE_MAX = 1500;

const HEADER = (t: T) => t("instr.ruleHeader");
const FOOTER = (t: T) => t("instr.ruleFooter");

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

function levelLine(
  name: string,
  description: string | undefined,
  policy: Policy,
  t: T,
): string {
  const cleanName = sanitize(name) || "level";
  const desc = description ? sanitize(description) : "";
  // orchestrator §2 rev 20: the pipeline's own level — coordinators
  // never delegate to it, `release` launches it. §2.3: auditor levels
  // check instead of doing.
  const tag =
    cleanName === "release-audit"
      ? t("instr.tagReleasePipeline")
      : levelRole(policy, name) === "auditor"
        ? t("instr.tagAuditor")
        : "";
  return `- ${cleanName}${desc ? ` — ${desc}` : ""}${tag}`;
}

/** §2.3: one line naming the reviewByLevel map, when configured. */
function reviewByLevelLine(policy: Policy, t: T): string | null {
  const map = policy.reviewByLevel;
  if (!map || Object.keys(map).length === 0) return null;
  const pairs = Object.entries(map).map(
    ([exec, review]) => `${exec} → ${review}`,
  );
  return t("instr.reviewByLevel", { pairs: pairs.join("; ") });
}

function limitsLine(policy: Policy, t: T): string | null {
  const limits = policy.limits;
  if (!limits) return null;
  const parts: string[] = [];
  if (limits.maxActive !== undefined) {
    parts.push(t("instr.limitActive", { n: limits.maxActive }));
  }
  for (const [level, cap] of Object.entries(limits.perLevel ?? {})) {
    parts.push(`${level} ≤ ${cap}`);
  }
  return parts.length ? t("instr.limits", { parts: parts.join("; ") }) : null;
}

export function generateRoutingRule(
  policy: Policy,
  t: T = T_RU,
): string {
  const limits = limitsLine(policy, t);
  const reviewLine = reviewByLevelLine(policy, t);
  const build = (line: (name: string, desc?: string) => string) =>
    [
      HEADER(t),
      "",
      t("instr.levelsHeader"),
      ...Object.entries(policy.levels).map(([name, l]) =>
        line(name, l.description),
      ),
      ...(limits ? ["", limits] : []),
      ...(reviewLine ? ["", reviewLine] : []),
      "",
      FOOTER(t),
    ].join("\n");

  let text = build((name, desc) => levelLine(name, desc, policy, t));
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
      policy,
      t,
    ),
  );
  if (text.length <= ROUTING_RULE_MAX) return text;
  return text.slice(0, ROUTING_RULE_MAX - 1) + "…";
}

/** Shown instead of a rule while the policy is missing or invalid.
 * Compat export — the `ru` catalog value; callers that honor `language`
 * use `t("instr.setupHint")`. */
export const SETUP_HINT_TEXT = RU["instr.setupHint"]!;

/**
 * §2.2 — the `gitInstructions` setting: repository git rules for executors,
 * prepended to `--instructions` at every dispatch (delegate and reissue).
 */
export const GIT_INSTRUCTIONS_MAX = 1500;

/** Compat export — the `ru` catalog value; callers that honor
 * `language` use `t("instr.gitDefault")`. */
export const DEFAULT_GIT_INSTRUCTIONS = RU["instr.gitDefault"]!;

/**
 * §18.1: a `gitInstructions` value matching the built-in text of ANY
 * language counts as "the default" — the dispatcher emits the current
 * language's built-in text instead of the stored one. An empty string
 * still suppresses the section (§2.2); an owner-edited value goes out
 * verbatim.
 */
export function isBuiltinGitInstructions(text: string): boolean {
  return (
    text === RU["instr.gitDefault"] || text === EN["instr.gitDefault"]
  );
}

/** §18.1: the effective §2.2 text — `undefined` (unset) and a
 * built-in-language value both render the CURRENT language's memo;
 * `""` suppresses the section; a custom value passes through. */
export function effectiveGitInstructions(
  text: string | undefined,
  t: T,
): string | undefined {
  if (text === undefined) return undefined;
  if (text.trim() === "") return text;
  return isBuiltinGitInstructions(text)
    ? t("instr.gitDefault")
    : text;
}

/**
 * Validation error for `gitInstructions`, or null when the value is usable.
 * The setting schema refuses over-limit writes; this catches values that
 * reached storage before the schema or through another path.
 */
export function gitInstructionsError(
  text: string | undefined,
  t: T = T_RU,
): string | null {
  if (text === undefined) return null;
  return text.length > GIT_INSTRUCTIONS_MAX
    ? t("instr.gitTooLong", { max: GIT_INSTRUCTIONS_MAX, len: text.length })
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
  t: T = T_RU,
): string {
  const prev = branch ?? continueFrom;
  // §16.6: merges carry an explicit `-m`; the message never embeds a
  // branch name or a thread id — a sha7 or a bare "merge".
  const mergeMsg = /^[0-9a-f]{7,40}$/i.test(continueFrom)
    ? `merge ${continueFrom.slice(0, 7)}`
    : "merge";
  return t("instr.round", {
    round,
    continueFrom,
    prev,
    mergeMsg,
  });
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
  t: T = T_RU,
): string {
  const parts = [
    ...(branch ? [t("instr.reviewBranch", { branch })] : []),
    ...(round != null ? [t("instr.reviewRoundN", { round })] : []),
  ];
  return t("instr.reviewRound", {
    from: continueFrom,
    tail: parts.length ? ` (${parts.join(", ")})` : "",
  });
}

/**
 * §4.1 r28: the `--no-code` dispatch's own line — the executor must not
 * touch the copy, the report IS the result.
 */
export const NO_CODE_LINE = RU["instr.noCode"]!;

/**
 * §2.2: the git-rules text becomes the first section of `--instructions`,
 * then the «Заход N» section when the dispatch continues a previous round,
 * then the §4.1 r28 «задача без кода» line for a `no_code` row, then this
 * call's extra instructions; an empty or over-limit value adds no section
 * (an over-limit value is also flagged needs-configuration so it is never
 * silently dropped). No text at all — no `--instructions` flag.
 *
 * §4.1 r28.1: for a `no_code` row the §2.2 memo is NOT sent — its
 * requirements to commit and to report a branch and a SHA would
 * contradict NO_CODE_LINE, which alone states the contract («не менять,
 * не коммитить; итог — отчёт»). The «Заход N» section still goes out:
 * landing on `continue_from` is positioning, not a commit requirement.
 */
export function mergeDispatchInstructions(
  gitInstructions: string | undefined,
  extra: string | undefined,
  round?: string | undefined,
  noCode?: boolean,
  t: T = T_RU,
): string | undefined {
  const git =
    gitInstructionsError(gitInstructions) === null
      ? (gitInstructions ?? "").trim()
      : "";
  const x = (extra ?? "").trim();
  const r = (round ?? "").trim();
  const parts = [
    ...(git && !noCode ? [git] : []),
    ...(r ? [r] : []),
    ...(noCode ? [t("instr.noCode")] : []),
    ...(x ? [x] : []),
  ];
  return parts.length ? parts.join("\n\n") : undefined;
}

