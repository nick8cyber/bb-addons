/**
 * §5.6 (r34.1, PLUG-317): shared upstream-merge detection — used by the
 * coordinator watchdog's `reconcileUpstreamPass`/`reconcileHistoryOnce`,
 * by `merge --mark-merged` (§14) and by the `merged-upstream` release
 * path (release §2 п.0.2). A result counts as landed on
 * `origin/<targetBranch>` when either `result_sha` is an ancestor of it
 * or a trial `git merge-tree --write-tree` produces EXACTLY the target
 * tree (the squash-merge of several commits into one upstream commit).
 */
import { OrchestratorError } from "./errors.js";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `git` inside a repo — never throws, mirrors `MergeGit`. */
export type UpstreamGit = (
  repo: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<GitResult>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * `git fetch origin <branch>` — one retry when the fetch lost a ref
 * lock race (`cannot lock ref`, `another process`), per spec §5.6.
 */
export async function fetchTargetBranch(
  git: UpstreamGit,
  repo: string,
  branch: string,
  opts?: { timeoutMs?: number },
): Promise<GitResult> {
  const run = () =>
    git(repo, ["fetch", "origin", branch], {
      timeoutMs: opts?.timeoutMs ?? 60_000,
    });
  const res = await run();
  if (res.exitCode === 0) return res;
  const out = `${res.stderr}\n${res.stdout}`;
  if (/cannot lock ref|lock ref|another process/i.test(out)) {
    return run();
  }
  return res;
}

/** True when `sha` exists in the repo's object store. */
export async function shaObjectExists(
  git: UpstreamGit,
  repo: string,
  sha: string,
): Promise<boolean> {
  const res = await git(repo, ["cat-file", "-e", sha], { timeoutMs: 30_000 });
  return res.exitCode === 0;
}

export async function isAncestor(
  git: UpstreamGit,
  repo: string,
  sha: string,
  ref: string,
): Promise<boolean> {
  const res = await git(repo, ["merge-base", "--is-ancestor", sha, ref], {
    timeoutMs: 30_000,
  });
  return res.exitCode === 0;
}

/** `git rev-parse <ref>` — trimmed stdout or null on failure. */
async function revParse(
  git: UpstreamGit,
  repo: string,
  ref: string,
): Promise<string | null> {
  const res = await git(repo, ["rev-parse", "--verify", "--quiet", ref], {
    timeoutMs: 30_000,
  });
  const out = res.stdout.trim().split("\n")[0] ?? "";
  return res.exitCode === 0 && out ? out : null;
}

/**
 * Trial merge: does merging `sha` into `ref` produce `ref`'s tree
 * EXACTLY? True ⇒ every change `sha` carries is already in `ref`
 * (squash/rebase landing). `git merge-tree --write-tree` prints the
 * result tree on stdout (optionally followed by conflict info).
 */
export async function mergeTreeEqualsRef(
  git: UpstreamGit,
  repo: string,
  ref: string,
  sha: string,
): Promise<boolean> {
  const refTree = await revParse(git, repo, `${ref}^{tree}`);
  if (!refTree) return false;
  const res = await git(repo, ["merge-tree", "--write-tree", ref, sha], {
    timeoutMs: 60_000,
  });
  if (res.exitCode !== 0) return false;
  const tree = res.stdout.trim().split("\n")[0] ?? "";
  return tree === refTree;
}

export interface UpstreamContainment {
  merged: boolean;
  /** `ancestor` — sha is in the target history; `tree` — the changes
   * landed through a squash/rebase (sha itself is not on the branch). */
  via: "ancestor" | "tree" | null;
  /** `origin/<branch>` tip after the (already done) fetch. */
  targetTip: string | null;
}

/**
 * Is `sha`'s content on `origin/<branch>`? Ancestor check first, then
 * the tree-equality probe for squash-landed work.
 */
export async function upstreamContains(
  git: UpstreamGit,
  repo: string,
  branch: string,
  sha: string,
): Promise<UpstreamContainment> {
  const target = `origin/${branch}`;
  const targetTip = await revParse(git, repo, target);
  if (!targetTip) return { merged: false, via: null, targetTip: null };
  if (await isAncestor(git, repo, sha, target)) {
    return { merged: true, via: "ancestor", targetTip };
  }
  if (await mergeTreeEqualsRef(git, repo, target, sha)) {
    return { merged: true, via: "tree", targetTip };
  }
  return { merged: false, via: null, targetTip };
}

/** §14 `--mark-merged`: the recorded upstream sha — the explicit sha
 * when given, else the result sha (ancestor) or the target tip (squash). */
export function upstreamMergedSha(
  explicitSha: string | undefined,
  resultSha: string,
  c: UpstreamContainment,
): string {
  return explicitSha ?? (c.via === "ancestor" ? resultSha : c.targetTip!);
}

/** The 15 s per-repo budget of reconcileUpstreamPass — every git call
 * of one repository visit runs under it. */
export const UPSTREAM_REPO_TIMEOUT_MS = 15_000;

/** Wrap a git runner so a whole repository visit shares one deadline. */
export function budgetGit(
  git: UpstreamGit,
  budgetMs: number = UPSTREAM_REPO_TIMEOUT_MS,
): UpstreamGit {
  const deadline = Date.now() + budgetMs;
  return async (repo, args, opts) => {
    const left = deadline - Date.now();
    if (left <= 0) {
      return {
        exitCode: 124,
        stdout: "",
        stderr: `upstream repo budget ${budgetMs}ms exhausted`,
      };
    }
    return git(repo, args, {
      timeoutMs: Math.min(opts?.timeoutMs ?? 60_000, left),
    });
  };
}

/** `no-repo` refusal shared by `--mark-merged` paths. */
export function noRepoError(detail: string): OrchestratorError {
  return new OrchestratorError("no-repo", `no-repo: ${detail}`);
}

export { message as upstreamMessage };
