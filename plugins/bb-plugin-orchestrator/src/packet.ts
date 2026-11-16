/**
 * §20.2/§21.3 (r33): the material packet for a `tools: false` route —
 * a provider without repo tools (a web session like Argon) gets the
 * whole review/research material in the first prompt: a header, the
 * task text, `git diff --stat`, the `--attach` files from the LINK
 * commit, and the `-U10` diff, with lockfiles/`dist/`/`node_modules/`/
 * binaries/secret files excluded and every scanner hit masked.
 *
 * The auditor packet (§20.2) takes a diff of the checked work
 * (`--from` or the task's last executor result); the researcher
 * packet (§21.3) ships a diff only when `--from` was given and never
 * triggers `packet-empty`.
 */
import { OrchestratorError } from "./errors.js";
import { T_RU, type T } from "./i18n/index.js";

/** §20.2: the packet byte cap when the route sets no `maxPromptBytes`. */
export const DEFAULT_MAX_PROMPT_BYTES = 150_000;
/** §20.2: the queue wait when the route sets no `routeBusyWaitSeconds`. */
export const DEFAULT_ROUTE_BUSY_WAIT_SECONDS = 1200;

/** `git -C <repo> <args>` returning stdout; throws on a nonzero exit. */
export type PacketGit = (repo: string, args: string[]) => Promise<string>;

/** §20.2: the packet spec persisted on the delegation (`attach`
 * column) — the `--attach` paths and the explicit `--from` ref. */
export interface PacketSpec {
  paths: string[];
  from: string | null;
}

export const EMPTY_SPEC: PacketSpec = { paths: [], from: null };

export function parseAttachSpec(attach: string | null | undefined): PacketSpec {
  if (!attach) return EMPTY_SPEC;
  try {
    const parsed = JSON.parse(attach) as {
      paths?: unknown;
      from?: unknown;
    };
    return {
      paths: Array.isArray(parsed?.paths)
        ? parsed.paths.filter((p): p is string => typeof p === "string")
        : [],
      from: typeof parsed?.from === "string" ? parsed.from : null,
    };
  } catch {
    return EMPTY_SPEC;
  }
}

/**
 * Thrown when a tool-less route is skipped — the SAME dispatch moves
 * to the next chain route (`packet-empty`, `packet-too-large`).
 */
export class PacketSkip extends Error {
  readonly reason: "packet-empty" | "packet-too-large";
  constructor(reason: "packet-empty" | "packet-too-large") {
    super(reason);
    this.name = "PacketSkip";
    this.reason = reason;
  }
}

/** §20.2: never in the packet — not the diff, not `--attach`, not the
 * stat. `.env*`, `secrets/`, `*.pem`, `*.key`. */
const SECRET_PATH_RES = [
  /(?:^|\/)\.env/i,
  /(?:^|\/)secrets\//i,
  /(?:^|\/)[^/]*\.pem$/i,
  /(?:^|\/)[^/]*\.key$/i,
];

export const isSecretPath = (path: string): boolean =>
  SECRET_PATH_RES.some((re) => re.test(path));

/** git pathspec excludes — lockfiles of every ecosystem, `dist/`,
 * `node_modules/`, and the secret paths above; the `**` globstar
 * prefix covers the repo root too. */
const SECRET_EXCLUDES = [
  ":(exclude)**/.env*",
  ":(exclude)**/secrets/**",
  ":(exclude)**/*.pem",
  ":(exclude)**/*.key",
];
const DIFF_EXCLUDES = [
  ...SECRET_EXCLUDES,
  ":(exclude)**/*.lock",
  ":(exclude)**/*-lock.json",
  ":(exclude)**/*-lock.yaml",
  ":(exclude)**/bun.lockb",
  ":(exclude)**/npm-shrinkwrap.json",
  ":(exclude)**/go.sum",
  ":(exclude)**/dist/**",
  ":(exclude)**/node_modules/**",
];

/** §20.2: a binary `--attach` (NUL in the first 8 KB or non-UTF-8 →
 * the utf8 decode leaves a U+FFFD) is refused. */
const isBinaryContent = (text: string): boolean => {
  const head = text.slice(0, 8192);
  return head.includes("\u0000") || head.includes("\uFFFD");
};

/** A `git diff` split into per-file chunks — `diff --git a/x b/y`
 * heads each. `file` is the `b/` path (unquoted); a preamble without
 * a header keeps it unset. Binary chunks («Binary files … differ» /
 * «GIT binary patch») stay out of the packet's diff — §20.2 п.2 shows
 * them only as a `--stat` line. */
function diffChunks(diff: string): { text: string; file?: string }[] {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((p) => p !== "")
    .filter(
      (p) =>
        !/^Binary files |^GIT binary patch/m.test(p),
    )
    .map((text) => {
      const m = /^diff --git a\/.+ b\/(.+)$/m.exec(text);
      const file = m?.[1]?.replace(/^"|"$/g, "");
      return { text, file: file || undefined };
    });
}

/** First ref from `candidates` that resolves, else undefined. */
async function resolveRef(
  git: PacketGit,
  repo: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const name of candidates) {
    try {
      const sha = (
        await git(repo, ["rev-parse", "--verify", `${name}^{commit}`])
      ).trim();
      if (sha) return sha;
    } catch {
      // next candidate
    }
  }
  return undefined;
}

export interface MaskFn {
  /** `file` — the packet block's source (an `--attach` path or a diff
   * hunk's `b/` name): the project's `leaks.allow` relaxes category
   * 3–4 hits inside it (§20.2 п.5 — the release scanner's rules). */
  (text: string, ctx: { projectId?: string | null; file?: string }): {
    text: string;
    count: number;
  };
}

/**
 * Wrap the first prompt of a `tools: false` dispatch in the §20.2
 * packet: `header + prompt + stat + attach files + diff`.
 *
 * Throws `OrchestratorError` (`attach-missing`, `attach-secret`,
 * `attach-binary`, `packet-repo`) for caller/dispatch refusals and
 * `PacketSkip` (`packet-empty`, `packet-too-large`) for route skips.
 */
export async function wrapPromptWithPacket(args: {
  /** `auditor` — JSON verdict required, diff of the checked work,
   * `packet-empty` applies; `researcher` — internet search allowed,
   * diff only with an explicit `--from`, never `packet-empty` (§21.3). */
  role: "auditor" | "researcher";
  /** The prompt being wrapped — the task part of the spawn seed. */
  prompt: string;
  /** §20.2 п.4 packet order — header → task → stat → files → diff →
   * preset/extra instructions: the caller's instruction tail rides
   * AFTER the material, masked like the task text. */
  trailing?: string;
  spec: PacketSpec;
  /** The row's `continue_from` — the auditor's fallback link (§20.2:
   * «иначе последний итог исполнителя этой задачи»). */
  continueFrom: string | null;
  /** The preset's `baseBranch` — the merge-base target hint. */
  baseBranch?: string | null;
  maxPromptBytes?: number;
  repoPath: string | null;
  git?: PacketGit;
  mask?: MaskFn;
  projectId?: string | null;
  /** §21.3 for helpers: the prompt itself is the material (a helper
   * carries no diff/attach spec) — `packet-empty` does not apply even
   * for the auditor header. */
  emptyOk?: boolean;
  t?: T;
}): Promise<{ prompt: string }> {
  const t = args.t ?? T_RU;
  const spec = args.spec;
  const link =
    args.role === "researcher"
      ? spec.from
      : (spec.from ?? args.continueFrom);
  const needsRepo = link !== null || spec.paths.length > 0;
  if (needsRepo && (!args.repoPath || !args.git)) {
    throw new OrchestratorError(
      "packet-repo",
      "cannot build the material packet: no repository access for " +
        "this dispatch (no environment path or git seam)",
    );
  }
  const repo = args.repoPath;
  const git = args.git!;

  // The merge-base target: the preset's baseBranch (origin copy first),
  // else the remote default, else the checkout's HEAD.
  let target: string | undefined;
  if (needsRepo) {
    const candidates = [
      ...(args.baseBranch
        ? [`origin/${args.baseBranch}`, args.baseBranch]
        : []),
      "origin/HEAD",
      "HEAD",
    ];
    target = await resolveRef(git, repo!, candidates);
    if (!target) {
      throw new OrchestratorError(
        "packet-repo",
        "cannot build the material packet: no target ref resolved",
      );
    }
  }

  let base: string | undefined;
  let stat = "";
  let diff = "";
  if (link !== null) {
    try {
      base = (
        await git(repo!, ["merge-base", target!, link])
      ).trim();
    } catch {
      base = undefined;
    }
    base = base || target;
    // §20.2 п.2: «git diff --stat и git diff -U10 … без lock-файлов,
    // dist/, node_modules/» — the stat keeps binary rows («Bin 0 → N
    // bytes») but drops the same noise the diff drops.
    stat = (
      await git(repo!, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--stat",
        `${base}..${link}`,
        "--",
        ".",
        ...DIFF_EXCLUDES,
      ])
    ).trim();
    diff = (
      await git(repo!, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-U10",
        `${base}..${link}`,
        "--",
        ".",
        ...DIFF_EXCLUDES,
      ])
    ).trim();
  }

  // §20.2 п.3: `--attach` files come from the LINK commit (the checked
  // work), or — without a link — from the target tip.
  const attachRef = link ?? target;
  const files: { path: string; content: string }[] = [];
  for (const path of spec.paths) {
    if (isSecretPath(path)) {
      throw new OrchestratorError(
        "attach-secret",
        `attach-secret: ${path}`,
      );
    }
    let content: string;
    try {
      content = await git(repo!, ["show", `${attachRef}:${path}`]);
    } catch {
      throw new OrchestratorError(
        "attach-missing",
        `attach-missing: ${path}`,
      );
    }
    if (isBinaryContent(content)) {
      throw new OrchestratorError(
        "attach-binary",
        `attach-binary: ${path}`,
      );
    }
    files.push({ path, content });
  }

  if (
    args.role === "auditor" &&
    !args.emptyOk &&
    diff === "" &&
    files.length === 0
  ) {
    // §20.2: no diff and no attached files — nothing to check.
    throw new PacketSkip("packet-empty");
  }

  // §20.2 п.5: the packet leaves for an external web service — mask
  // every scanner hit before it goes out, the caller's own text (task,
  // comments, --instructions) included. Attached files and diff hunks
  // are masked with their path so `leaks.allow` relaxes categories
  // 3–4 exactly where the release scanner does.
  const maskPart = (text: string, file?: string) =>
    args.mask
      ? args.mask(text, { projectId: args.projectId, file })
      : { text, count: 0 };
  const maskedPrompt = maskPart(args.prompt);
  const maskedTrailing = args.trailing?.trim()
    ? maskPart(args.trailing)
    : { text: "", count: 0 };
  const maskedStat =
    link !== null
      ? maskPart(
          `=== git diff --stat ${base}..${link} ===\n${stat || "—"}\n\n`,
        )
      : { text: "", count: 0 };
  const maskedFiles = files.map((f) =>
    maskPart(
      `=== ${f.path} ===\n${f.content.replace(/\n*$/, "")}\n`,
      f.path,
    ),
  );
  const maskedDiff =
    link !== null && diff !== ""
      ? diffChunks(diff).map((c) => maskPart(c.text, c.file))
      : [];
  const body =
    maskedStat.text +
    maskedFiles.map((m) => m.text).join("\n") +
    (maskedDiff.length
      ? `${files.length ? "\n" : ""}=== git diff -U10 ${base}..${link} ===\n` +
        maskedDiff.map((m) => m.text).join("") +
        "\n"
      : "");
  const count =
    maskedPrompt.count +
    maskedTrailing.count +
    maskedStat.count +
    maskedFiles.reduce((n, m) => n + m.count, 0) +
    maskedDiff.reduce((n, m) => n + m.count, 0);
  const header = t(
    args.role === "researcher" ? "pkt.headerResearch" : "pkt.headerAudit",
    {
      masked: count > 0 ? t("pkt.masked", { n: count }) : "",
    },
  );
  // §20.2 п.4: шапка → задача → --stat → файлы → дифф → инструкции.
  const prompt =
    `${header}\n\n${maskedPrompt.text}\n\n${body}` +
    (maskedTrailing.text ? `\n\n${maskedTrailing.text}` : "");
  const cap = args.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES;
  if (Buffer.byteLength(prompt, "utf8") > cap) {
    throw new PacketSkip("packet-too-large");
  }
  return { prompt };
}
