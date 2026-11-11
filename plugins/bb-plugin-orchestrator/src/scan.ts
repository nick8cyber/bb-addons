/**
 * Machine leak scan (spec orchestrator-release §4) — pipeline step 4.
 * `gitleaks` covers category 1 (secrets); plugin templates cover
 * categories 2-4 over the added lines of EVERY commit's patch in the
 * range `merge-base(origin/<цель>, HEAD)..HEAD` (§16.6 — a finding added
 * and removed inside the range is still caught) plus the release diff's
 * added lines and the commit metadata. Categories 1-2 always block; 3-4
 * follow the project's `leaks` strictness with `allow` places where such
 * mentions are the norm. `thr_…` ids are exempt only while the project's
 * `threadIds` is on (§16.6).
 *
 * Findings never carry secret values — a finding that quotes the leak
 * would itself leak (§3). Descriptions name the rule and the masked hit.
 */
import { OrchestratorError } from "./errors.js";
import type { CmdRunner } from "./cmd.js";
import type { ResolvedProject } from "./release-config.js";

export type LeakCategory = 1 | 2 | 3 | 4;

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

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export const EMPTY_TREE_SHA =
  "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ── Allow places (§4 `allow`) ──────────────────────────────────────────

const GLOBSTAR = "";

const globToRe = (glob: string) => {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, "[^/]*")
    .split(GLOBSTAR)
    .join(".*");
  return new RegExp(`^${escaped}$`);
};

/** `allow` entries: a trailing `/` means a directory prefix; `*`/`**` are
 * globs; anything else is an exact path. */
export function isAllowed(file: string, allow: readonly string[]): boolean {
  return allow.some((entry) => {
    const e = entry.trim();
    if (!e) return false;
    if (e.endsWith("/")) return file.startsWith(e);
    if (e.includes("*")) return globToRe(e).test(file);
    return file === e;
  });
}

// ── Secret masking (§3: findings must not carry values) ───────────────

const SECRET_VALUE_RES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?=-----END|$)/g,
  /vless:\/\/\S+/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{10,}/g,
  /PrivateKey\s*=\s*\S+/g,
];

/** Replace every secret-shaped value with `prefix…***` (first 6 chars
 * kept so the finding still identifies which credential it was). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE_RES) {
    out = out.replace(re, (m) => `${m.slice(0, 6)}…***`);
  }
  return out;
}

// ── Category 1: secrets ────────────────────────────────────────────────

const PLUGIN_SECRET_RULES: { rule: string; re: RegExp }[] = [
  { rule: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { rule: "vless-uri", re: /vless:\/\// },
  {
    rule: "github-token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{10,}/,
  },
  {
    rule: "api-key",
    re: /\bsk-[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b/,
  },
  { rule: "vpn-private-key", re: /PrivateKey\s*=\s*\S+/ },
];

/** File names that are secrets by themselves (§4 category 1 examples). */
const SECRET_FILE_RE =
  /(?:^|\/)(?:\.env(?:\..+)?|[^/]*\.pem|[^/]*\.key|id_rsa|id_ed25519|id_dsa|id_ecdsa)$/i;

// ── Category 2: author identity ────────────────────────────────────────

const PERSONAL_EMAIL_RE =
  /[\w.+-]+@(?:gmail|googlemail|yandex|ya\.ru|mail\.ru|bk\.ru|inbox\.ru|list\.ru|outlook|hotmail|live|yahoo|icloud|me\.com|proton\.me|protonmail|rambler)\.[a-z.]+/i;

const FOREIGN_BOT_TRAILER_RE =
  /^\s*(?:Co-Authored-By|Co-authored-by|Signed-off-by|Generated with|Generated-by)\s*:?[ \t]/im;

// ── Category 3: machine binding ────────────────────────────────────────

const MACHINE_RULES: { rule: string; re: RegExp }[] = [
  { rule: "home-path", re: /\/(?:home|Users)\/[A-Za-z0-9._-]+\// },
  { rule: "opt-path", re: /\/opt\/[A-Za-z0-9._-]/ },
  {
    rule: "private-ip",
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
];

// ── Category 4: bb identifiers ─────────────────────────────────────────

const BB_ID_RULES: { rule: string; re: RegExp }[] = [
  { rule: "bb-thread-id", re: /\bthr_[a-z0-9]{6,}\b/i },
  { rule: "bb-project-id", re: /\bproj_[a-z0-9]{6,}\b/i },
  { rule: "bb-env-id", re: /\benv_[a-z0-9]{6,}\b/i },
  { rule: "getbb-host", re: /\b[a-z0-9-]+\.getbb\.app\b/i },
  {
    rule: "task-key",
    // §4: private tracker keys like PLUG-156; encodings are not keys.
    re: /\b[A-Z][A-Z0-9]{1,9}-\d+\b(?!\s*(?:charset|encoding))/,
  },
];

/** Common false positives of the task-key template: encodings and
 * version-like tokens that are legitimate in code and docs. */
const TASK_KEY_ALLOW = new Set([
  "UTF-8", "UTF-16", "UTF-32", "ISO-8859", "SHA-1", "SHA-256", "SHA-384",
  "SHA-512", "MD-5", "DES-3", "AES-128", "AES-192", "AES-256",
]);

const isTaskKeyToken = (token: string) =>
  /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(token) && !TASK_KEY_ALLOW.has(token);

/** §4: the `BB-Thread:` trailer line in a commit message is contract, not
 * a leak — strip it before scanning commit bodies for category 4. The
 * exemption holds only while `threadIds` is on (§16.6): with `threadIds`
 * off every `thr_…` in commit text is a `leaks.bbIds` finding, trailer
 * included. */
const BB_THREAD_TRAILER_RE = /^\s*BB-Thread\s*:[^\n]*$/gim;

/** §16.6 `threadIds`: `true` (default) — `thr_…` ids are anonymized and
 * the pipeline needs them, so the `bb-thread-id` rule is off; other bb
 * ids stay. `false` — every `thr_…` is a finding. */
const bbIdRules = (threadIds: boolean) =>
  threadIds
    ? BB_ID_RULES.filter((r) => r.rule !== "bb-thread-id")
    : BB_ID_RULES;

const hits = (text: string, rules: { rule: string; re: RegExp }[]) =>
  rules.filter(({ re }) => re.test(text)).map(({ rule }) => rule);

const hostRe = (hostname: string) =>
  new RegExp(`\\b${hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

function scanAddedLines(
  added: readonly AddedLine[],
  leaks: ResolvedProject["leaks"],
  hostname: string | undefined,
  threadIds = true,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const hostRule =
    hostname && hostname.length > 2
      ? { rule: "hostname", re: hostRe(hostname) }
      : undefined;
  const machineRules = hostRule
    ? [...MACHINE_RULES, hostRule]
    : MACHINE_RULES;
  const bbRules = bbIdRules(threadIds);
  for (const { file, line, text } of added) {
    // §4: `allow` places relax categories 3–4 only — secrets and author
    // identity (categories 1–2) are checked everywhere, always block.
    const allowed = isAllowed(file, leaks.allow);
    if (SECRET_FILE_RE.test(file)) {
      findings.push({
        category: 1,
        file,
        line,
        rule: "secret-file",
        problem: "добавлен файл секрета (.env, ключ, id_*)",
        severity: "block",
      });
    }
    for (const rule of hits(text, PLUGIN_SECRET_RULES)) {
      findings.push({
        category: 1,
        file,
        line,
        rule,
        problem: `возможный секрет (${rule}): ${maskSecrets(text.slice(0, 120))}`,
        severity: "block",
      });
    }
    if (PERSONAL_EMAIL_RE.test(text)) {
      findings.push({
        category: 2,
        file,
        line,
        rule: "personal-email",
        problem: "личная почта в тексте",
        severity: "block",
      });
    }
    for (const rule of hits(text, machineRules)) {
      if (allowed) continue;
      findings.push({
        category: 3,
        file,
        line,
        rule,
        problem: `привязка к машине (${rule}): ${maskSecrets(text.slice(0, 120))}`,
        severity: leaks.machine,
      });
    }
    for (const rule of hits(text, bbRules)) {
      if (allowed) continue;
      if (rule === "task-key") {
        const tokens = text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [];
        if (!tokens.some(isTaskKeyToken)) continue;
      }
      findings.push({
        category: 4,
        file,
        line,
        rule,
        problem: `идентификатор bb (${rule})`,
        severity: leaks.bbIds,
      });
    }
  }
  return findings;
}

function scanCommitMeta(
  commits: readonly CommitMeta[],
  allowed: { name: string; email: string } | undefined,
  leaks: ResolvedProject["leaks"],
  hostname: string | undefined,
  threadIds = true,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const short = (sha: string) => sha.slice(0, 8);
  const bbRules = bbIdRules(threadIds);
  for (const c of commits) {
    // Category 2 — the signature must equal the configured one.
    const ok =
      allowed !== undefined &&
      c.authorName === allowed.name &&
      c.authorEmail === allowed.email &&
      c.committerName === allowed.name &&
      c.committerEmail === allowed.email;
    if (!ok) {
      findings.push({
        category: 2,
        file: null,
        line: null,
        rule: "commit-identity",
        problem:
          `коммит ${short(c.sha)}: подпись ` +
          `${c.authorName} <${c.authorEmail}> / ${c.committerName} <${c.committerEmail}>` +
          (allowed
            ? ` не совпадает с разрешённой ${allowed.name} <${allowed.email}>`
            : " — commitIdentity не задан в настройке release"),
        severity: "block",
      });
    }
    if (FOREIGN_BOT_TRAILER_RE.test(c.body)) {
      findings.push({
        category: 2,
        file: null,
        line: null,
        rule: "foreign-bot-trailer",
        problem: `коммит ${short(c.sha)}: трейлер чужого бота (Co-Authored-By / Signed-off-by / Generated with)`,
        severity: "block",
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
        problem: `коммит ${short(c.sha)}: привязка к машине в сообщении (${rule})`,
        severity: leaks.machine,
      });
    }
    if (hostname && hostname.length > 2 && hostRe(hostname).test(body)) {
      findings.push({
        category: 3,
        file: null,
        line: null,
        rule: "hostname",
        problem: `коммит ${short(c.sha)}: имя хоста в сообщении`,
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
        problem: `коммит ${short(c.sha)}: идентификатор bb в сообщении (${rule})`,
        severity: leaks.bbIds,
      });
    }
    if (PERSONAL_EMAIL_RE.test(c.body)) {
      findings.push({
        category: 2,
        file: null,
        line: null,
        rule: "personal-email",
        problem: `коммит ${short(c.sha)}: личная почта в сообщении`,
        severity: "block",
      });
    }
  }
  return findings;
}

// ── Diff parsing ───────────────────────────────────────────────────────

/** Added lines of `git diff --unified=0`, with post-image line numbers.
 * Deleted files (`+++ /dev/null`) and binary hunks are skipped. */
export function parseAddedLines(diffText: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | null = null;
  let line = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    // `@@` regular hunks and `@@@` combined-diff hunks (merge patches
    // under `git log -p --cc`): the post-image start is the + group.
    const hunk = /^@+ (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? @+/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("+")) {
      out.push({ file, line, text: raw.slice(1) });
      line += 1;
    } else if (raw.startsWith(" ")) {
      line += 1;
    }
  }
  return out;
}

// ── gitleaks (category 1, §4) ──────────────────────────────────────────

interface GitleaksFinding {
  RuleID?: string;
  File?: string;
  StartLine?: number | string;
}

/**
 * `gitleaks git --log-opts "<base>..<head>"` over the release range.
 * `--exit-code 7` separates "found leaks" from operational failures; the
 * report goes to stdout (`-r -`) and only RuleID/File/line are kept —
 * `Secret`/`Match` never leave gitleaks' output.
 */
export async function runGitleaks(
  cmd: CmdRunner,
  repoPath: string,
  baseSha: string,
  headSha: string,
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
      "gitleaks не установлен — машинный скан категории 1 невозможен",
      "установите gitleaks (https://github.com/gitleaks/gitleaks) и повторите release",
    );
  }
  if (res.exitCode !== 0 && res.exitCode !== 7) {
    throw new OrchestratorError(
      "scan-failed",
      `gitleaks завершился с ошибкой (exit ${res.exitCode}): ${res.stderr.trim().slice(0, 300) || res.stdout.trim().slice(0, 300)}`,
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
      `gitleaks вернул нечитаемый отчёт: ${text.slice(0, 200)}`,
    );
  }
  return rows.map((r) => ({
    category: 1,
    file: typeof r.File === "string" ? r.File : null,
    line: Number.isFinite(Number(r.StartLine)) ? Number(r.StartLine) : null,
    rule: `gitleaks:${r.RuleID ?? "unknown"}`,
    problem: `секрет (${r.RuleID ?? "unknown"})`,
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
    allowedAuthor?: { name: string; email: string } | undefined;
    hostname?: string | undefined;
    /** §16.6 `threadIds` — default `true` (`thr_…` is not a leak). */
    threadIds?: boolean;
  },
): Promise<ScanFinding[]> {
  const findings: ScanFinding[] = [];
  findings.push(
    ...(await runGitleaks(cmd, input.repoPath, input.baseSha, input.headSha)),
  );
  findings.push(
    ...scanCommitMeta(
      input.commits,
      input.allowedAuthor,
      input.leaks,
      input.hostname,
      input.threadIds ?? true,
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
    ),
  );
  return findings;
}

/** The §2 refusal text: «файл:строка → категория». */
export const CATEGORY_NAMES: Record<LeakCategory, string> = {
  1: "секреты",
  2: "личность автора",
  3: "привязка к машине",
  4: "идентификаторы bb",
};

export function formatFinding(f: ScanFinding): string {
  const where = f.file
    ? `${f.file}${f.line != null ? `:${f.line}` : ""}`
    : "коммиты";
  return `${where} → ${CATEGORY_NAMES[f.category]} (${f.rule}): ${f.problem}`;
}
