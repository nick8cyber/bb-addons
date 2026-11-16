/**
 * Pure added-lines leak scanner — the SINGLE source of the §4 template
 * rules shared by the release machine scan (`src/scan.ts`, i18n findings
 * for the coordinator) and the shared `pre-commit` git hook (§22.1).
 * No plugin imports and no i18n on purpose: the installed hook loads
 * this file with plain `node` (type stripping) — keep it
 * dependency-free (node builtins only).
 *
 * What lives here: `allow` places, secret masking, the category 1–4
 * rule tables, the unified-diff added-lines parser and
 * `scanAddedLinesCore` — one pass over added lines returning findings as
 * {category, kind, rule, fragment}. Callers attach their own severity
 * and their own wording; the fragment is already masked and ≤120 chars.
 */
import { hostname as osHostname } from "node:os";

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export type LeakCategory = 1 | 2 | 3 | 4;

export interface CoreFinding {
  category: LeakCategory;
  file: string;
  line: number;
  /** Which check produced the finding — the callers map it to their
   * wording (`scan.secretFile`/`possibleSecret`/`personalEmail`/
   * `machine`/`bbId` vs the hook's type names). */
  kind: "secret-file" | "secret" | "personal-email" | "machine" | "bbid";
  /** Template or file rule name. */
  rule: string;
  /** Masked and truncated (≤120 chars) added-line text. */
  fragment: string;
}

// ── Allow places (§4 `allow`) ──────────────────────────────────────────

const GLOBSTAR = "\x01";

const globToRe = (glob: string) => {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, "[^/]*")
    .split(GLOBSTAR)
    .join(".*");
  return new RegExp(`^${escaped}$`);
};

/** §4 built-in exceptions — applied in every scan, snapshot or not.
 * The leak-fixture file is the ONE place positive samples may live
 * (release §4 «Синтетические пути в тестах»); it is exempt wherever a
 * repository keeps it: root `tests/` or nested `plugins/<id>/tests/`. */
export const BUILTIN_ALLOW: readonly string[] = [
  "tests/fixtures/leak-samples.ts",
  "**/tests/fixtures/leak-samples.ts",
];

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

// ── Synthetic fixture values (§4 r11.1) ────────────────────────────────

const allSameChar = (s: string) => s.length > 0 && /^(.)\1+$/.test(s);

/** Known token prefixes of the category-1 rules — the part of a match
 * that is NOT the secret body (`ghp_` + 36×`x` has body `x…x`). */
const SECRET_PREFIX_RE =
  /^(?:github_pat_|[a-z]{3}_|xox[baprs]-|sk-|AKIA|AIza|ya29\.)/;

/** §4 r11.1: a value in token form that is provably NOT a credential —
 * the marker `EXAMPLE` anywhere in the match, or the body after the
 * known token prefix is a single repeated char (`ghp_` + 36×`x`,
 * `AKIA` + 16×`X`). Exempt only inside `allow` fixture files — the same
 * value anywhere else is a category-1 finding as usual. */
export function isSyntheticSecret(m: string): boolean {
  if (m.includes("EXAMPLE")) return true;
  const p = SECRET_PREFIX_RE.exec(m);
  if (!p) return false;
  return allSameChar(m.slice(p[0].length));
}

/** §4 r11.1 applied to category 2 (PLUG-273 заход 3, слово координатора):
 * a personal address is synthetic when it carries `EXAMPLE` in the
 * local part or a repeated-char local part. Without this no literal
 * positive sample can exist at all — a provider-domain address is a
 * finding in EVERY file, the fixture file included. */
export function isSyntheticEmail(m: string): boolean {
  if (m.includes("EXAMPLE")) return true;
  const local = m.slice(0, m.indexOf("@"));
  return allSameChar(local);
}

/** Unmasked secret-shaped values of a line — used to decide whether a
 * gitleaks hit inside an `allow` file is all-synthetic (§4 r11.1). */
export function secretValues(text: string): string[] {
  const out: string[] = [];
  for (const re of SECRET_VALUE_RES) {
    for (const m of text.matchAll(new RegExp(re.source, "g"))) {
      out.push(m[0]);
    }
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
  // §22.1: the local part is bounded (RFC 5321: ≤64 chars) — an
  // unbounded `[\w.+-]+` is quadratic on a >1 MiB one-line `.map`
  // blob without a single '@' (greedy consume + per-char backtrack).
  /[\w.+-]{1,64}@(?:gmail|googlemail|yandex|ya\.ru|mail\.ru|bk\.ru|inbox\.ru|list\.ru|outlook|hotmail|live|yahoo|icloud|me\.com|proton\.me|protonmail|rambler)\.[a-z.]+/i;

/** §17.3 (С6): every personal-address hit in the text, minus the
 * project's `allowedEmails` — an exact address (`a@b.c`) or a domain
 * (`@b.c` or bare `b.c`) in the list is not a finding. */
export function personalEmailHits(
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

// ── Category 3: machine binding ────────────────────────────────────────

export interface MachineRule {
  rule: string;
  re: RegExp;
  /** §4 (r8): an occurrence matching this pattern is a test fixture,
   * not a leak — checked per occurrence, so a fixture prefix next to a
   * real path in one line is still a finding. Written as a regex so the
   * literal prefix never appears in the scanner's own source (the
   * installed scanner would flag it). */
  exempt?: RegExp;
}

export const MACHINE_RULES: MachineRule[] = [
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
    // All four octets — `172.16.0` (a three-part version string) is
    // not an address.
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
];

// ── Category 4: bb identifiers ─────────────────────────────────────────

const BB_ID_RULES: { rule: string; re: RegExp }[] = [
  { rule: "bb-thread-id", re: /\bthr_[a-z0-9]{6,}\b/i },
  { rule: "bb-project-id", re: /\bproj_[a-z0-9]{6,}\b/i },
  { rule: "bb-env-id", re: /\benv_[a-z0-9]{6,}\b/i },
  // §22.1: a DNS label is ≤63 chars — bounded for the same
  // quadratic-backtracking reason as the email local part.
  { rule: "getbb-host", re: /\b[a-z0-9-]{1,63}\.getbb\.app\b/i },
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

export const isTaskKeyToken = (token: string) =>
  /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(token) && !TASK_KEY_ALLOW.has(token);

/** §4: the `BB-Thread:` trailer line in a commit message is contract, not
 * a leak — strip it before scanning commit bodies for category 4. The
 * exemption holds only while `threadIds` is on (§16.6): with `threadIds`
 * off every `thr_…` in commit text is a `leaks.bbIds` finding, trailer
 * included. */
export const BB_THREAD_TRAILER_RE = /^\s*BB-Thread\s*:[^\n]*$/gim;

/** §16.6 `threadIds` governs ALL bb identifiers (thread ids AND task
 * keys): `true` (default) — `thr_…` ids are anonymized and the pipeline
 * needs them, and tracker keys in the pipeline's own messages
 * (`merge <KEY> r<N>`) are legitimate — both `bb-thread-id` and
 * `task-key` rules are off; other bb ids stay. `false` — every `thr_…`
 * and every task key is a `leaks.bbIds` finding. */
export const bbIdRules = (threadIds: boolean) =>
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

export const hits = (text: string, rules: MachineRule[]) =>
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

/** Like `hits` but also returns the offset of the first non-exempt
 * occurrence — the fragment window is centered on it. */
const hitEntries = (text: string, rules: MachineRule[]) =>
  rules.flatMap(({ rule, re, exempt }) => {
    for (const m of text.matchAll(new RegExp(re.source, "g"))) {
      if (exempt && exempt.test(m[0])) continue;
      return [{ rule, index: m.index ?? 0 }];
    }
    return [];
  });

/** §22.1 (ревью): the finding's fragment is a window AROUND the match —
 * in a >1 MiB one-line `.map` the first 120 bytes are `{"version":3,…`,
 * not the leak. The window widens to fully cover every secret-shaped
 * value it touches so `maskSecrets` never sees a truncated secret, and
 * the ≤120 cap applies AFTER masking (a `prefix…***` replacement is
 * longer than the 6 raw chars it keeps). */
function fragmentAround(text: string, index: number): string {
  let start = Math.max(0, index - 60);
  let end = Math.min(text.length, index + 60);
  for (const re of SECRET_VALUE_RES) {
    for (const m of text.matchAll(new RegExp(re.source, "g"))) {
      const s = m.index ?? 0;
      const e = s + m[0].length;
      if (s < end && e > start) {
        if (s < start) start = s;
        if (e > end) end = e;
      }
    }
  }
  const masked = maskSecrets(text.slice(start, end));
  if (masked.length <= 120) return masked;
  // Masking only shrinks text — the match sits at most `index-start`
  // characters into `masked`; center the final window on it.
  const pos = Math.min(index - start, masked.length - 1);
  const s = Math.max(0, Math.min(pos - 60, masked.length - 120));
  return masked.slice(s, s + 120);
}

export const hostRe = (hostname: string) =>
  new RegExp(`\\b${hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

/** One pass over the added lines (§4 categories 1–4): secret file names,
 * secret-shaped values, personal emails, machine bindings and bb
 * identifiers. `allow` places relax categories 3–4 only — secrets and
 * author identity are checked everywhere. Findings are language-free:
 * callers attach wording and severity. */
export function scanAddedLinesCore(
  added: readonly AddedLine[],
  opts: {
    allow?: readonly string[];
    hostname?: string | undefined;
    threadIds?: boolean;
    /** §22.1: `thr_…` in FILE content is a finding even when the
     * project anonymizes thread ids — `threadIds` exempts the
     * `BB-Thread:` trailer in commit MESSAGES (a file line is not a
     * trailer), and the `task-key` rule still follows `threadIds`. */
    flagThreadIds?: boolean;
    allowedEmails?: readonly string[];
  } = {},
): CoreFinding[] {
  const allow = [...BUILTIN_ALLOW, ...(opts.allow ?? [])];
  const threadIds = opts.threadIds ?? true;
  const allowedEmails = opts.allowedEmails ?? [];
  const hostname = opts.hostname ?? osHostname();
  const findings: CoreFinding[] = [];
  const hostRule: MachineRule | undefined =
    hostname.length > 2
      ? { rule: "hostname", re: hostRe(hostname) }
      : undefined;
  const machineRules = hostRule
    ? [...MACHINE_RULES, hostRule]
    : MACHINE_RULES;
  let bbRules = bbIdRules(threadIds);
  if (opts.flagThreadIds && !bbRules.some((r) => r.rule === "bb-thread-id")) {
    bbRules = [
      BB_ID_RULES.find((r) => r.rule === "bb-thread-id")!,
      ...bbRules,
    ];
  }
  for (const { file, line, text } of added) {
    // §4: `allow` places relax categories 3–4 only — secrets and author
    // identity (categories 1–2) are checked everywhere, always block.
    const allowed = isAllowed(file, allow);
    if (SECRET_FILE_RE.test(file)) {
      findings.push({
        category: 1,
        file,
        line,
        kind: "secret-file",
        rule: "secret-file",
        fragment: "",
      });
    }
    for (const { rule, re } of PLUGIN_SECRET_RULES) {
      for (const m of text.matchAll(new RegExp(re.source, "g"))) {
        // §4 r11.1: inside an `allow` fixture file a synthetic value
        // (EXAMPLE marker, or a one-repeated-char body after the token
        // prefix) is not a finding — a real-looking body still is, so
        // every occurrence is checked, not just the first.
        if (allowed && isSyntheticSecret(m[0])) continue;
        findings.push({
          category: 1,
          file,
          line,
          kind: "secret",
          rule,
          fragment: fragmentAround(text, m.index ?? 0),
        });
        break; // one finding per rule per line, as before
      }
    }
    const emails = personalEmailHits(text, allowedEmails).filter(
      (m) => !(allowed && isSyntheticEmail(m)),
    );
    if (emails.length) {
      findings.push({
        category: 2,
        file,
        line,
        kind: "personal-email",
        rule: "personal-email",
        fragment: fragmentAround(text, text.indexOf(emails[0]!)),
      });
    }
    for (const h of hitEntries(text, machineRules)) {
      if (allowed) continue;
      findings.push({
        category: 3,
        file,
        line,
        kind: "machine",
        rule: h.rule,
        fragment: fragmentAround(text, h.index),
      });
    }
    for (const h of hitEntries(text, bbRules)) {
      if (allowed) continue;
      if (h.rule === "task-key") {
        const tokens = text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [];
        if (!tokens.some(isTaskKeyToken)) continue;
      }
      findings.push({
        category: 4,
        file,
        line,
        kind: "bbid",
        rule: h.rule,
        fragment: fragmentAround(text, h.index),
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

