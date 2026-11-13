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
 * are the norm. `thr_…` ids are exempt only while the project's
 * `threadIds` is on (§16.6).
 *
 * Findings never carry secret values — a finding that quotes the leak
 * would itself leak (§3). Descriptions name the rule and the masked hit.
 */
import { OrchestratorError } from "./errors.js";
import { RU } from "./i18n/ru.js";
import { T_RU, type T } from "./i18n/index.js";
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

/** §17.3 (С6): every personal-address hit in the text, minus the
 * project's `allowedEmails` — an exact address (`a@b.c`) or a domain
 * (`@b.c` or bare `b.c`) in the list is not a finding. */
function personalEmailHits(
  text: string,
  allowedEmails: readonly string[],
): string[] {
  const matches =
    text.match(new RegExp(PERSONAL_EMAIL_RE.source, "gi")) ?? [];
  if (!allowedEmails.length) return matches;
  const allowed = allowedEmails.map((a) => a.trim().toLowerCase());
  return matches.filter((m) => {
    const lower = m.toLowerCase();
    const domain = lower.slice(lower.indexOf("@"));
    return !allowed.some(
      (a) =>
        (a.startsWith("@") && domain === a) ||
        (a.includes("@") && lower === a) ||
        (!a.includes("@") && domain === `@${a}`),
    );
  });
}

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

// ── Category 3: machine binding ────────────────────────────────────────

interface MachineRule {
  rule: string;
  re: RegExp;
  /** §4 (r8): an occurrence matching this pattern is a test fixture,
   * not a leak — checked per occurrence, so a fixture prefix next to a
   * real path in one line is still a finding. Written as a regex so the
   * literal prefix never appears in the scanner's own source (the
   * installed scanner would flag it). */
  exempt?: RegExp;
}

const MACHINE_RULES: MachineRule[] = [
  {
    rule: "home-path",
    // The trailing slash is a LOOKAHEAD, not consumed: a fixture
    // prefix glued to a real path with no separator (`/…/example/` +
    // `home/alice`) must leave the real path its own occurrence
    // (ревью PLUG-231 заход 2). The exempt is anchored — the fixture
    // is the exact `example` segment, `examplefoo` stays a finding.
    re: /\/(?:home|Users)\/[A-Za-z0-9._-]+(?=\/)/,
    exempt: /^\/(?:home|Users)\/example$/,
  },
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

/** §16.6 `threadIds` governs ALL bb identifiers (thread ids AND task
 * keys): `true` (default) — `thr_…` ids are anonymized and the pipeline
 * needs them, and tracker keys in the pipeline's own messages
 * (`merge <KEY> r<N>`) are legitimate — both `bb-thread-id` and
 * `task-key` rules are off; other bb ids stay. `false` — every `thr_…`
 * and every task key is a `leaks.bbIds` finding. */
const bbIdRules = (threadIds: boolean) =>
  threadIds
    ? BB_ID_RULES.filter(
        (r) => r.rule !== "bb-thread-id" && r.rule !== "task-key",
      )
    : BB_ID_RULES;

/** §16.6 (PLUG-194): does the text carry a bb identifier — a `thr_…`/
 * `proj_…`/`env_…` id, a `*.getbb.app` host, or a tracker task key?
 * Used for the neutral PR title: a HEAD subject with any of these is
 * replaced by `release <sha7>` while `threadIds` is off. */
export function hasBbIds(text: string): boolean {
  for (const { rule, re } of BB_ID_RULES) {
    if (!re.test(text)) continue;
    if (rule === "task-key") {
      const tokens = text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [];
      if (!tokens.some(isTaskKeyToken)) continue;
    }
    return true;
  }
  return false;
}

const hits = (text: string, rules: MachineRule[]) =>
  rules
    .filter(({ re, exempt }) => {
      if (!exempt) return re.test(text);
      // §4 (r8): the rule fires only when at least one occurrence is
      // not an exempt fixture prefix.
      for (const m of text.matchAll(new RegExp(re.source, "g"))) {
        if (!exempt.test(m[0])) return true;
      }
      return false;
    })
    .map(({ rule }) => rule);

const hostRe = (hostname: string) =>
  new RegExp(`\\b${hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

function scanAddedLines(
  added: readonly AddedLine[],
  leaks: ResolvedProject["leaks"],
  hostname: string | undefined,
  threadIds = true,
  allowedEmails: readonly string[] = [],
  t: T = T_RU,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const hostRule: MachineRule | undefined =
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
        problem: t("scan.secretFile"),
        severity: "block",
      });
    }
    for (const rule of hits(text, PLUGIN_SECRET_RULES)) {
      findings.push({
        category: 1,
        file,
        line,
        rule,
        problem: t("scan.possibleSecret", {
          rule,
          text: maskSecrets(text.slice(0, 120)),
        }),
        severity: "block",
      });
    }
    if (personalEmailHits(text, allowedEmails).length) {
      findings.push({
        category: 2,
        file,
        line,
        rule: "personal-email",
        problem: t("scan.personalEmail"),
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
        problem: t("scan.machine", {
          rule,
          text: maskSecrets(text.slice(0, 120)),
        }),
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
        problem: t("scan.bbId", { rule }),
        severity: leaks.bbIds,
      });
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

// ── Diff parsing ───────────────────────────────────────────────────────

/** Added lines of `git diff --unified=0`, with post-image line numbers.
 * Deleted files (`+++ /dev/null`) and binary hunks are skipped.
 *
 * Combined diffs (`@@@` hunks — merge-commit patches under `git log -p
 * --cc`) carry one prefix column PER PARENT: a line is a real addition
 * only when every column is `+`; `+ ` means "content of one parent,
 * already public" — not a finding; a `-` in any column means the line is
 * not in the merge result at all, so it does not advance the post-image
 * line number (PLUG-189 finding 6). */
export function parseAddedLines(diffText: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | null = null;
  let line = 0;
  let columns = 0; // prefix columns per content line (1 regular, 2+ combined)
  // §16.6 (PLUG-191): a `+++`/`---`/`@@`-looking line inside a hunk is
  // CONTENT, not a header (`++ /dev/null` added to a file prints as
  // `+++ /dev/null` and used to un-pin `file`, losing every later line
  // of that file). The hunk's own counts tell where its body ends:
  // pre-image lines per parent and post-image lines from `+N,M`.
  let inHunk = false;
  let preLeft: number[] = [];
  let postLeft = 0;
  for (const raw of diffText.split("\n")) {
    if (!inHunk) {
      if (raw.startsWith("+++ ")) {
        const p = raw.slice(4).trim();
        file = p === "/dev/null" ? null : p.replace(/^b\//, "");
        continue;
      }
      // `@@` regular hunks and `@@@`/`@@@@` combined-diff hunks: the
      // post-image start is the + group; prefix columns = @ count − 1.
      const hunk =
        /^(@+) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? @+/.exec(raw);
      if (hunk) {
        columns = hunk[1]!.length - 1;
        preLeft = [...hunk[2]!.matchAll(/-\d+(?:,(\d+))?/g)].map(
          (m) => (m[1] === undefined ? 1 : Number(m[1])),
        );
        postLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
        line = Number(hunk[3]);
        inHunk = postLeft > 0 || preLeft.some((n) => n > 0);
      }
      continue;
    }
    // In a hunk: `\ No newline at end of file` consumes nothing.
    if (raw.startsWith("\\")) continue;
    if (columns <= 1) {
      if (raw.startsWith("+")) {
        if (file) out.push({ file, line, text: raw.slice(1) });
        line += 1;
        postLeft -= 1;
      } else if (raw.startsWith("-")) {
        preLeft[0]! -= 1;
      } else if (raw.startsWith(" ")) {
        preLeft[0]! -= 1;
        postLeft -= 1;
        line += 1;
      } else {
        continue; // empty/malformed — do not touch the counters
      }
    } else {
      // Combined hunk: examine the per-parent prefix columns.
      if (raw.length < columns) continue;
      const prefix = raw.slice(0, columns);
      for (let i = 0; i < columns; i += 1) {
        if (prefix[i] === "-" || prefix[i] === " ") preLeft[i]! -= 1;
      }
      if (prefix.includes("-")) {
        // absent from the merge result — no post-image line consumed
      } else {
        if (file && [...prefix].every((c) => c === "+")) {
          out.push({ file, line, text: raw.slice(columns) });
        }
        line += 1; // present in the result, added or already-public
        postLeft -= 1;
      }
    }
    if (postLeft <= 0 && preLeft.every((n) => n <= 0)) inHunk = false;
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
  t: T = T_RU,
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
  return rows.map((r) => ({
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
    /** §16.6 `threadIds` — default `true` (`thr_…` is not a leak). */
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
