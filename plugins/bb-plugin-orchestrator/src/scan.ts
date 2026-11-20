/**
 * Machine leak scan (spec orchestrator-release §4) — pipeline step 4.
 * `gitleaks` covers category 1 (secrets); plugin templates cover
 * categories 2-4 over the added lines of EVERY commit's patch in the
 * range `merge-base(origin/<цель>, HEAD)..HEAD` (§16.6 — a finding added
 * and removed inside the range is still caught) plus the release diff's
 * added lines and the commit metadata. Category 1 (secrets) always
 * blocks; in category 2 a signature mismatch blocks whenever an
 * identity IS configured, a MISSING `commitIdentity` only warns
 * (§4 r11/§18.6 — `status` reports it), and a `"repo"` identity the
 * repo config cannot resolve blocks with
 * «в конфиге репозитория не задан user.name/user.email»; foreign-bot
 * trailers follow `leaks.trailers` (§18.6); 3-4 follow the
 * project's `leaks` strictness with `allow` places where such mentions
 * are the norm. `threadIds` (§16.6) exempts only the `BB-Thread:`
 * trailer in commit MESSAGES — §22.5: `thr_…` in file content is a
 * finding at release too, `leaks.allow` places aside.
 *
 * Findings never carry secret values — a finding that quotes the leak
 * would itself leak (§3). Descriptions name the rule and the masked hit.
 */
import { OrchestratorError } from "./errors.js";
import {
  BB_THREAD_TRAILER_RE,
  BUILTIN_ALLOW,
  MACHINE_RULES,
  bbIdRules,
  hasBbIds,
  hasRealDocsThreadId,
  hits,
  hostRe,
  isAllowed,
  isSyntheticSecret,
  isTaskKeyToken,
  maskSecrets,
  parseAddedLines,
  personalEmailHits,
  scanAddedLinesCore,
  secretValues,
  type AddedLine,
  type CoreFinding,
} from "../hooks/leak-scan.js";

export {
  hasBbIds,
  hasRealDocsThreadId,
  isAllowed,
  maskSecrets,
  parseAddedLines,
} from "../hooks/leak-scan.js";
export type { AddedLine } from "../hooks/leak-scan.js";
export type { LeakCategory } from "../hooks/leak-scan.js";
import type { LeakCategory } from "../hooks/leak-scan.js";
import { RU } from "./i18n/ru.js";
import { T_RU, type T } from "./i18n/index.js";
import type { CmdRunner } from "./cmd.js";
import type { ResolvedProject } from "./release-config.js";

export interface ScanFinding {
  category: LeakCategory;
  file: string | null;
  line: number | null;
  /** Template or gitleaks rule name — how the finding was caught. */
  rule: string;
  /** Masked, never the secret value. */
  problem: string;
  severity: "block" | "warn";
}

export interface CommitMeta {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  body: string;
}

/**
 * §4 r11/§18.6: how the category-2 signature check resolved the
 * project's `commitIdentity` — the states decide the finding's
 * severity and suffix:
 * - `resolved` — the allowed name/email to match (mismatch blocks);
 * - `unset` — no `commitIdentity` configured: the finding WARNS;
 * - `repo-unset` — `commitIdentity: "repo"` but the repo config has no
 *   `user.name`/`user.email`: the finding BLOCKS (as before r11);
 * - `invalid` — a configured literal that does not parse: BLOCKS;
 * - `strict` — the post-check without a release config, where the
 *   pre-§18.6 strict defaults apply: BLOCKS.
 */
export type IdentityResolution =
  | { state: "resolved"; name: string; email: string }
  | { state: "unset" }
  | { state: "repo-unset" }
  | { state: "invalid" }
  | { state: "strict" };

export const EMPTY_TREE_SHA =
  "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ── Category 2: author identity ────────────────────────────────────────

/** §17.3 (С6): the foreign-bot trailer names category 2 scans for. */
export const FOREIGN_BOT_TRAILER_NAMES = [
  "Co-Authored-By",
  "Signed-off-by",
  "Generated with",
  "Generated-by",
] as const;

const FOREIGN_BOT_MARKER_RE = new RegExp(
  `^\\s*(${FOREIGN_BOT_TRAILER_NAMES.join("|")})\\s*:?[ \\t]([^\\n]*)`,
  "gim",
);

/** §17.3 (С6): one `allowedTrailers` element — a trailer name (every
 * value allowed) or «name: value prefix»; the name must be a trailer
 * the scan actually produces. Matching ignores case. */
export interface AllowedTrailer {
  name: string;
  /** Value head; `null` — every value allowed. */
  prefix: string | null;
}

export function parseAllowedTrailer(entry: string): AllowedTrailer | null {
  const t = entry.trim();
  const i = t.indexOf(":");
  const name = (i < 0 ? t : t.slice(0, i)).trim();
  const prefix = i < 0 ? null : t.slice(i + 1).trim();
  if (
    !FOREIGN_BOT_TRAILER_NAMES.some(
      (n) => n.toLowerCase() === name.toLowerCase(),
    ) ||
    prefix === ""
  ) {
    return null;
  }
  return { name: name.toLowerCase(), prefix: prefix?.toLowerCase() ?? null };
}

/** §17.3 (С6): foreign-bot trailers found in the commit body that no
 * `allowedTrailers` element covers — a bare name covers every value,
 * «name: prefix» only values starting with it (case-insensitive). */
function foreignTrailers(
  body: string,
  allowedTrailers: readonly string[],
): string[] {
  const allowed = allowedTrailers
    .map(parseAllowedTrailer)
    .filter((a): a is AllowedTrailer => a !== null);
  const found: string[] = [];
  for (const m of body.matchAll(FOREIGN_BOT_MARKER_RE)) {
    const name = m[1]!.toLowerCase();
    const value = (m[2] ?? "").trim().toLowerCase();
    const covered = allowed.some(
      (a) =>
        a.name === name &&
        (a.prefix === null || value.startsWith(a.prefix)),
    );
    if (!covered) found.push(m[1]!);
  }
  return found;
}

// ── Category 4: bb identifiers (rules — hooks/leak-scan.ts) ──

/** Map a shared-core finding to the i18n `ScanFinding` shape — the
 * release scan's wording and the project's strictness live here. */
function scanAddedLines(
  added: readonly AddedLine[],
  leaks: ResolvedProject["leaks"],
  hostname: string | undefined,
  threadIds = true,
  allowedEmails: readonly string[] = [],
  t: T = T_RU,
): ScanFinding[] {
  const core = scanAddedLinesCore(added, {
    allow: leaks.allow,
    hostname,
    threadIds,
    // §22.5: `threadIds` exempts only the commit-message trailer —
    // `thr_…` in the diff is a finding (allow places aside).
    flagThreadIds: true,
    allowedEmails,
  });
  const at = (f: CoreFinding, problem: string, severity: "block" | "warn") =>
    ({
      category: f.category,
      file: f.file,
      line: f.line,
      rule: f.rule,
      problem,
      severity,
    }) as ScanFinding;
  const findings: ScanFinding[] = [];
  for (const f of core) {
    switch (f.kind) {
      case "secret-file":
        findings.push(at(f, t("scan.secretFile"), "block"));
        break;
      case "secret":
        findings.push(
          at(f, t("scan.possibleSecret", { rule: f.rule, text: f.fragment }), "block"),
        );
        break;
      case "personal-email":
        findings.push(at(f, t("scan.personalEmail"), "block"));
        break;
      case "machine":
        findings.push(
          at(f, t("scan.machine", { rule: f.rule, text: f.fragment }), leaks.machine),
        );
        break;
      case "bbid": {
        const isBannedDocsThreadId =
          f.rule === "bb-thread-id" &&
          f.file !== null &&
          /(?:^|\/)docs(?:\/|$)/.test(f.file) &&
          hasRealDocsThreadId(f.fragment);
        findings.push(
          at(
            f,
            t("scan.bbId", { rule: f.rule }),
            isBannedDocsThreadId ? "block" : leaks.bbIds,
          ),
        );
        break;
      }
    }
  }
  return findings;
}

function scanCommitMeta(
  commits: readonly CommitMeta[],
  identity: IdentityResolution,
  leaks: ResolvedProject["leaks"],
  hostname: string | undefined,
  threadIds = true,
  allowedTrailers: readonly string[] = [],
  allowedEmails: readonly string[] = [],
  t: T = T_RU,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const short = (sha: string) => sha.slice(0, 8);
  const bbRules = bbIdRules(threadIds);
  for (const c of commits) {
    // Category 2 — the signature must equal the configured one.
    const ok =
      identity.state === "resolved" &&
      c.authorName === identity.name &&
      c.authorEmail === identity.email &&
      c.committerName === identity.name &&
      c.committerEmail === identity.email;
    if (!ok) {
      findings.push({
        category: 2,
        file: null,
        line: null,
        rule: "commit-identity",
        problem: t("scan.commitSig", {
          sha: short(c.sha),
          sig:
            `${c.authorName} <${c.authorEmail}> / ` +
            `${c.committerName} <${c.committerEmail}>`,
          why:
            identity.state === "resolved"
              ? t("scan.sigMismatch", {
                  name: identity.name,
                  email: identity.email,
                })
              : identity.state === "repo-unset"
                ? t("scan.sigRepoUnset")
                : identity.state === "invalid"
                  ? t("scan.sigInvalid")
                  : t("scan.sigUnset"),
        }),
        // §4 r11/§18.6: only a MISSING commitIdentity warns — the
        // pipeline goes on and `status` reports the absent
        // configuration. An identity that is configured but
        // unresolvable (or the post-check's strict fallback) blocks.
        severity: identity.state === "unset" ? "warn" : "block",
      });
    }
    const trailers = foreignTrailers(c.body, allowedTrailers);
    if (trailers.length) {
      findings.push({
        category: 2,
        file: null,
        line: null,
        rule: "foreign-bot-trailer",
        problem: t("scan.botTrailer", {
          sha: short(c.sha),
          trailers: trailers.join(", "),
        }),
        // §18.6: `leaks.trailers` ("warn" by default, "block" on the
        // author's install) — allowedTrailers still exempts.
        severity: leaks.trailers,
      });
    }
    // Categories 3–4 over commit text; the BB-Thread trailer is exempt
    // while threadIds is on — with it off even the trailer is a finding.
    const body = threadIds ? c.body.replace(BB_THREAD_TRAILER_RE, "") : c.body;
    for (const rule of hits(body, MACHINE_RULES)) {
      findings.push({
        category: 3,
        file: null,
        line: null,
        rule,
        problem: t("scan.commitMachine", {
          sha: short(c.sha),
          rule,
        }),
        severity: leaks.machine,
      });
    }
    if (hostname && hostname.length > 2 && hostRe(hostname).test(body)) {
      findings.push({
        category: 3,
        file: null,
        line: null,
        rule: "hostname",
        problem: t("scan.commitHost", { sha: short(c.sha) }),
        severity: leaks.machine,
      });
    }
    for (const rule of hits(body, bbRules)) {
      if (rule === "task-key") {
        const tokens = body.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [];
        if (!tokens.some(isTaskKeyToken)) continue;
      }
      findings.push({
        category: 4,
        file: null,
        line: null,
        rule,
        problem: t("scan.commitBbId", {
          sha: short(c.sha),
          rule,
        }),
        severity: leaks.bbIds,
      });
    }
    if (personalEmailHits(c.body, allowedEmails).length) {
      findings.push({
        category: 2,
        file: null,
        line: null,
        rule: "personal-email",
        problem: t("scan.commitEmail", { sha: short(c.sha) }),
        severity: "block",
      });
    }
  }
  return findings;
}

// ── gitleaks (category 1, §4) ──────────────────────────────────────────

interface GitleaksFinding {
  RuleID?: string;
  File?: string;
  StartLine?: number | string;
  /** Commit where gitleaks saw the hit — the blob to re-check for the
   * §4 r11.1 synthetic-fixture exemption. */
  Commit?: string;
}

/** §4 r11.1: a gitleaks hit inside an `allow` fixture file is not a
 * finding when every secret-shaped value on that line is synthetic
 * (one repeated char after the prefix, or the `EXAMPLE` marker). The
 * filter can only REMOVE a finding it fully explains — an unreadable
 * blob, a line carrying a real-looking value, or a shape outside our
 * rule table stays a finding. */
async function gitleaksSyntheticOnly(
  cmd: CmdRunner,
  repoPath: string,
  r: GitleaksFinding,
  headSha: string,
): Promise<boolean> {
  const line = Number(r.StartLine);
  if (!r.File || !Number.isFinite(line) || line < 1) return false;
  const sha = typeof r.Commit === "string" && r.Commit ? r.Commit : headSha;
  const res = await cmd.run(
    "git",
    ["-C", repoPath, "show", `${sha}:${r.File}`],
    { timeoutMs: 30_000 },
  );
  if (res.exitCode !== 0) return false;
  const text = res.stdout.split("\n")[line - 1];
  if (text === undefined) return false;
  const vals = secretValues(text);
  return vals.length > 0 && vals.every(isSyntheticSecret);
}

/**
 * `gitleaks git --log-opts "<base>..<head>"` over the release range.
 * `--exit-code 7` separates "found leaks" from operational failures; the
 * report goes to stdout (`-r -`) and only RuleID/File/line are kept —
 * `Secret`/`Match` never leave gitleaks' output. Findings inside the
 * project's `allow` fixture files are dropped when the hit's own line
 * carries only synthetic values (§4 r11.1).
 */
export async function runGitleaks(
  cmd: CmdRunner,
  repoPath: string,
  baseSha: string,
  headSha: string,
  t: T = T_RU,
  allow: readonly string[] = [],
): Promise<ScanFinding[]> {
  const res = await cmd.run(
    "gitleaks",
    [
      "git",
      "--log-opts",
      `${baseSha}..${headSha}`,
      "-f",
      "json",
      "-r",
      "-",
      "--exit-code",
      "7",
      "--no-banner",
      "--redact",
      repoPath,
    ],
    { timeoutMs: 120_000 },
  );
  if (res.exitCode === 127) {
    throw new OrchestratorError(
      "gitleaks-missing",
      t("scan.gitleaksMissing"),
      t("scan.gitleaksMissingHint"),
    );
  }
  if (res.exitCode !== 0 && res.exitCode !== 7) {
    throw new OrchestratorError(
      "scan-failed",
      t("scan.gitleaksExit", {
        code: res.exitCode,
        out:
          res.stderr.trim().slice(0, 300) || res.stdout.trim().slice(0, 300),
      }),
    );
  }
  const text = res.stdout.trim();
  if (!text) return [];
  let rows: GitleaksFinding[];
  try {
    const parsed = JSON.parse(text) as unknown;
    rows = Array.isArray(parsed) ? (parsed as GitleaksFinding[]) : [];
  } catch {
    throw new OrchestratorError(
      "scan-failed",
      t("scan.gitleaksReport", { text: text.slice(0, 200) }),
    );
  }
  const allowPaths = [...BUILTIN_ALLOW, ...allow];
  const kept: GitleaksFinding[] = [];
  for (const r of rows) {
    if (
      typeof r.File === "string" &&
      isAllowed(r.File, allowPaths) &&
      (await gitleaksSyntheticOnly(cmd, repoPath, r, headSha))
    ) {
      continue;
    }
    kept.push(r);
  }
  return kept.map((r) => ({
    category: 1,
    file: typeof r.File === "string" ? r.File : null,
    line: Number.isFinite(Number(r.StartLine)) ? Number(r.StartLine) : null,
    rule: `gitleaks:${r.RuleID ?? "unknown"}`,
    problem: t("scan.secretRule", { rule: r.RuleID ?? "unknown" }),
    severity: "block",
  }));
}

/** The whole step-4 scan: gitleaks + plugin templates. `patches` — §16.6
 * per-commit added lines (`git log -p --cc` over the range): a leak added
 * and removed inside the range is still caught. */
export async function machineScan(
  cmd: CmdRunner,
  input: {
    repoPath: string;
    baseSha: string;
    headSha: string;
    commits: readonly CommitMeta[];
    added: readonly AddedLine[];
    /** Added lines across every commit's patch in the range (§16.6). */
    patches?: readonly AddedLine[];
    leaks: ResolvedProject["leaks"];
    /** §18.6: the resolved `commitIdentity` state — absent means
     * `unset` (the signature check only warns). */
    identity?: IdentityResolution;
    hostname?: string | undefined;
    /** §16.6 `threadIds` — default `true`: the `BB-Thread:` trailer in
     * commit messages is not a leak; §22.5 — `thr_…` in file content
     * still is. */
    threadIds?: boolean;
    /** §17.3 (С6): foreign-bot trailers the project accepts. */
    allowedTrailers?: readonly string[];
    /** §17.3 (С6): emails/domains that are not a leak. */
    allowedEmails?: readonly string[];
    /** §18.1: finding texts — the language catalog. */
    t?: T;
  },
): Promise<ScanFinding[]> {
  const t = input.t ?? T_RU;
  const findings: ScanFinding[] = [];
  findings.push(
    ...(await runGitleaks(
      cmd,
      input.repoPath,
      input.baseSha,
      input.headSha,
      t,
      input.leaks.allow,
    )),
  );
  findings.push(
    ...scanCommitMeta(
      input.commits,
      input.identity ?? { state: "unset" },
      input.leaks,
      input.hostname,
      input.threadIds ?? true,
      input.allowedTrailers ?? [],
      input.allowedEmails ?? [],
      t,
    ),
  );
  // Range-diff lines ∪ per-commit patch lines, deduped — the same added
  // line must not surface the same finding twice.
  const seen = new Set<string>();
  const added = [...input.added, ...(input.patches ?? [])].filter((l) => {
    const key = `${l.file} ${l.line} ${l.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  findings.push(
    ...scanAddedLines(
      added,
      input.leaks,
      input.hostname,
      input.threadIds ?? true,
      input.allowedEmails ?? [],
      t,
    ),
  );
  return findings;
}

/** The §2 refusal text: «файл:строка → категория». */
/** Compat export — the `ru` category names; language-aware callers use
 * `categoryNames(t)`. */
export const CATEGORY_NAMES: Record<LeakCategory, string> = {
  1: RU["scan.cat1"]!,
  2: RU["scan.cat2"]!,
  3: RU["scan.cat3"]!,
  4: RU["scan.cat4"]!,
};

export function categoryNames(t: T): Record<LeakCategory, string> {
  return {
    1: t("scan.cat1"),
    2: t("scan.cat2"),
    3: t("scan.cat3"),
    4: t("scan.cat4"),
  };
}

export function formatFinding(f: ScanFinding, t: T = T_RU): string {
  const where = f.file
    ? `${f.file}${f.line != null ? `:${f.line}` : ""}`
    : t("scan.commitsWord");
  return `${where} → ${categoryNames(t)[f.category]} (${f.rule}): ${f.problem}`;
}
