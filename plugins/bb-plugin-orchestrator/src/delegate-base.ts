/**
 * §22.2 (r33.1): the delegation copy's base is the PUBLISHED target —
 * `origin/<baseBranch>` — never the local branch of the project copy,
 * which may carry unpushed commits an executor would silently inherit.
 *
 * Every managed-worktree dispatch first runs `git fetch` on the target
 * repo (the project's `local_path` source on the target host), resolves
 * `origin/<base>` and passes it to the spawn as the named base branch.
 * A fetch failure or a missing `origin/<base>` refuses the dispatch
 * with `base-unavailable: <error>`.
 *
 * An explicit `--from <ref>` is checked too — but only the dangerous
 * case refuses: `<ref>` being the copy's LOCAL target branch
 * (`main`/`master`/`dev`) with commits that are neither in
 * `origin/<base>` nor from this task (its own rounds, merged task
 * results, release pipeline shas) — that is an accidental grab of
 * somebody else's unpublished work: `from-unpublished: <n> коммитов не
 * в origin/<цель> и не из этой задачи`. A coordinator's spec branch, a
 * sha or `HEAD` may always pass.
 *
 * The check runs only where the plugin can actually reach git: a target
 * host other than this machine, a project without a `local_path`
 * source on that host, an unreadable `bb project list`, or a missing
 * `cmd` runner all skip — the spawn then keeps the preset's own base,
 * exactly as before r33.1, and the `delegate` response names the skip
 * reason («база не проверена: <причина>»).
 */
import type { BbCli } from "./bb-cli.js";
import type { CmdRunner } from "./cmd.js";
import type { DelegationStore } from "./store.js";

export interface DelegateBaseDeps {
  store: DelegationStore;
  bbCli: BbCli;
  /** git access — absent in tests/odd embedders: the base check skips. */
  cmd?: CmdRunner;
  /** This machine's bb hostId; absent (or "") — the target is treated
   * as local (the common single-machine install). */
  localHostId?: () => string | Promise<string>;
  /** §22.1: refresh the repo's `orchestrator-leaks.json` snapshot — the
   * executor's worktree shares the common dir and scans staged diffs
   * with the project's rules from its first commit. Best-effort. */
  leaksSnapshot?: (repo: string, projectId: string) => void | Promise<void>;
}

export interface DelegateBaseArgs {
  /** The task's linked bb project — its `local_path` source on the
   * target host is the repo `git fetch` runs against. */
  projectId: string;
  /** The spawn target host (preset `machineId` or `primaryHostId`). */
  hostId: string;
  /** The preset's `baseBranch`; null — the worktree's `{kind:"default"}`
   * base, resolved against `origin/HEAD`. */
  baseBranchName: string | null;
  /** §22.2 case 3: an explicit `--from` ref, if the caller gave one. */
  from?: string;
  taskKey: string;
  /** The COORDINATOR's bb project — delegation rows (and the
   * `merged_into` records `bb orchestrator merge` leaves) are stored
   * under it, not under the task's linked project. */
  callerProjectId?: string | null;
}

/** §22.2: why the published-base check did not run — each reason maps
 * to a line of the delegate response («база не проверена: <причина>»). */
export type BaseSkipReason =
  /** No `cmd` runner to reach git with. */
  | "no-cmd"
  /** The spawn target host is not this machine. */
  | "remote-host"
  /** `bb project list` failed or returned no usable JSON. */
  | "project-list"
  /** The project has no `local_path` source on the target host. */
  | "no-local-path";

export type DelegateBaseResult =
  | { kind: "named"; name: string }
  | { kind: "default" }
  /** The check cannot run here — keep the preset's base unchanged and
   * say why in the delegate response. */
  | { kind: "skip"; reason: BaseSkipReason }
  /** A refusal the caller must surface (`base-unavailable` /
   * `from-unpublished`, detail after the colon). */
  | { refuse: string };

/** The copy's local target branches — the only `--from` values §22.2
 * polices. */
const TARGET_BRANCH_NAMES = new Set(["main", "master", "dev"]);

interface BbProjectListSource {
  type?: string;
  path?: string | null;
  isDefault?: boolean;
  hostId?: string | null;
}

export interface BbProjectListItem {
  id?: string;
  sources?: BbProjectListSource[];
}

const shaRe = /^[0-9a-f]{40}$/i;

async function git(
  cmd: CmdRunner,
  repo: string,
  args: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) {
  return cmd.run("git", ["-C", repo, ...args], {
    timeoutMs: opts?.timeoutMs ?? 60_000,
    stdin: opts?.stdin,
  });
}

/** The project's `local_path` source ON the target host — a source
 * without `hostId` is a pre-hostfield record and counts as local
 * (same rule as `settingsProjectId`); exported for the server's
 * leaks-snapshot sweep, which resolves the same path. */
export function projectRepoPath(
  projects: BbProjectListItem[],
  projectId: string,
  hostId: string,
  localHost: string,
): string | null {
  const p = projects.find((x) => x.id === projectId);
  if (!p) return null;
  const local = (p.sources ?? []).filter(
    (s) => s.type === "local_path" && s.path,
  );
  // A source without `hostId` is a pre-hostfield record and counts as
  // local — when `localHost` is empty (no host id resolved) the check
  // already treats the target as local, so such a record matches it.
  const onHost = local.filter(
    (s) => (s.hostId || localHost || hostId) === hostId,
  );
  const def = onHost.find((s) => s.isDefault === true);
  if (def) return def.path!;
  // A single local_path source still names the project's repo even
  // without `isDefault` (pre-default records) — several sources stay
  // ambiguous and skip.
  if (local.length === 1 && onHost.length === 1) return local[0]!.path!;
  return null;
}

/** The "из этой задачи" allowance of `from-unpublished` (§22.2):
 * ranges `continue_from..result_sha` of THIS task's rounds and of
 * tasks merged into `<ref>` by `bb orchestrator merge` (plus the
 * recorded `merged_sha` merge commit), and release-pipeline shas —
 * exempted individually. Only each task's OWN range is exempt: an
 * `--not <task sha>` would hide every foreign commit under the tip,
 * which is exactly the hole `from-unpublished` closes.
 *
 * Task shas may name objects absent from the repo (another checkout's
 * executor commit), so each endpoint is verified with `cat-file`
 * before it joins a range — an unknown rev would fail `rev-list`. */
async function exemptShasInRepo(
  deps: DelegateBaseDeps,
  repo: string,
  args: DelegateBaseArgs,
  from: string,
): Promise<{ exempt: Set<string>; tips: Set<string> }> {
  const cmd = deps.cmd!;
  const ranges: { c: string | null; r: string }[] = [];
  const singles = new Set<string>();
  const tips = new Set<string>();
  for (const r of [
    ...deps.store.delegationsByTask(args.taskKey),
    // Rows live under the task's project (PLUG-395), falling back to
    // coordinator's project for legacy records.
    ...deps.store.mergedDelegationsInto(
      from,
      args.projectId ?? args.callerProjectId ?? null,
    ),
  ]) {
    if (r.result_sha && shaRe.test(r.result_sha)) {
      tips.add(r.result_sha);
      ranges.push({
        c:
          r.continue_from && shaRe.test(r.continue_from)
            ? r.continue_from
            : null,
        r: r.result_sha,
      });
    }
    if (r.continue_from && shaRe.test(r.continue_from)) {
      tips.add(r.continue_from);
    }
    if (r.merged_sha && shaRe.test(r.merged_sha)) {
      singles.add(r.merged_sha);
    }
  }
  for (const sha of deps.store.publishedShasForRepo(repo)) {
    if (shaRe.test(sha)) singles.add(sha);
  }
  for (const sha of deps.store.pipelineShasForRepo(repo)) {
    if (shaRe.test(sha)) singles.add(sha);
  }
  const candidates = new Set<string>([...singles, ...tips]);
  for (const { c, r } of ranges) {
    candidates.add(r);
    if (c) candidates.add(c);
  }
  const list = [...candidates];
  const present = new Set<string>();
  if (list.length) {
    const probe = await git(cmd, repo, ["cat-file", "--batch-check"], {
      stdin: `${list.join("\n")}\n`,
    });
    if (probe.exitCode === 0) {
      for (const s of list) {
        if (
          probe.stdout
            .split("\n")
            .some((l) => l.startsWith(`${s} `) && /\bcommit\b/.test(l))
        ) {
          present.add(s);
        }
      }
    }
  }
  const exempt = new Set<string>([...singles].filter((s) => present.has(s)));
  for (const { c, r } of ranges) {
    if (!present.has(r)) continue;
    if (c && present.has(c)) {
      const span = await git(cmd, repo, ["rev-list", r, "--not", c]);
      if (span.exitCode === 0) {
        for (const l of span.stdout.split("\n").filter(Boolean)) {
          exempt.add(l);
        }
        exempt.add(c);
      }
    }
    exempt.add(r);
  }
  return { exempt, tips: new Set([...tips].filter((t) => present.has(t))) };
}

export async function delegateBase(
  deps: DelegateBaseDeps,
  args: DelegateBaseArgs,
): Promise<DelegateBaseResult> {
  if (!deps.cmd) return { kind: "skip", reason: "no-cmd" };
  const cmd = deps.cmd;

  const localHost = deps.localHostId
    ? String((await deps.localHostId()) ?? "")
    : "";
  // §22.2 applies only where this process can run git — a managed
  // worktree on another host keeps the preset's base.
  if (localHost && args.hostId && args.hostId !== localHost) {
    return { kind: "skip", reason: "remote-host" };
  }

  const list = await deps.bbCli.run(["project", "list", "--json"], {
    timeoutMs: 30_000,
  });
  if (list.exitCode !== 0) return { kind: "skip", reason: "project-list" };
  let projects: BbProjectListItem[];
  try {
    const parsed: unknown = JSON.parse(list.stdout);
    if (!Array.isArray(parsed)) {
      return { kind: "skip", reason: "project-list" };
    }
    projects = parsed as BbProjectListItem[];
  } catch {
    return { kind: "skip", reason: "project-list" };
  }
  const repo = projectRepoPath(projects, args.projectId, args.hostId, localHost);
  if (!repo) return { kind: "skip", reason: "no-local-path" };

  // Every delegation refreshes `origin` first — a stale remote ref is
  // as wrong a base as a local branch.
  const fetch = await git(cmd, repo, ["fetch", "origin"], {
    timeoutMs: 120_000,
  });
  if (fetch.exitCode !== 0 || fetch.timedOut) {
    const detail = (fetch.stderr || fetch.stdout).trim() || "git fetch failed";
    return { refuse: `base-unavailable: ${detail.slice(0, 300)}` };
  }

  // §22.1: refresh the repo's leaks snapshot — the executor's worktree
  // scans staged diffs against these rules from its first commit.
  try {
    await deps.leaksSnapshot?.(repo, args.projectId);
  } catch {
    // best-effort — a failed snapshot never blocks a delegation
  }

  // The preset's named base, or the remote's default branch for
  // `{kind:"default"}` — `origin/HEAD` first, then the usual names.
  let base = args.baseBranchName;
  if (!base) {
    const head = await git(cmd, repo, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    base =
      head.exitCode === 0
        ? head.stdout.trim().replace(/^origin\//, "")
        : "";
    if (!base) {
      for (const guess of ["main", "master", "dev"]) {
        const probe = await git(cmd, repo, [
          "rev-parse",
          "--verify",
          "--quiet",
          `origin/${guess}`,
        ]);
        if (probe.exitCode === 0) {
          base = guess;
          break;
        }
      }
    }
    if (!base) {
      return { refuse: "base-unavailable: no origin default branch" };
    }
  }

  const baseOk = await git(cmd, repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    `origin/${base}`,
  ]);
  if (baseOk.exitCode !== 0) {
    return { refuse: `base-unavailable: no origin/${base}` };
  }

  // §22.2 case 3: `--from` refuses only a LOCAL target branch of the
  // copy carrying commits that are neither published nor this task's.
  if (args.from) {
    // Normalize the spelling: `refs/heads/x` is the same local branch
    // as `x`, and `HEAD`/`@` names the checked-out one — neither may
    // slip past the target-branch check by spelling.
    let from = args.from.trim();
    if (from === "HEAD" || from === "@") {
      const head = await git(cmd, repo, [
        "symbolic-ref",
        "-q",
        "--short",
        "HEAD",
      ]);
      if (head.exitCode === 0 && head.stdout.trim()) {
        from = head.stdout.trim();
      }
    } else if (from.startsWith("refs/heads/")) {
      from = from.slice("refs/heads/".length);
    }
    const localBranch = await git(cmd, repo, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${from}`,
    ]);
    const isTargetBranch =
      from === base || TARGET_BRANCH_NAMES.has(from);
    if (localBranch.exitCode === 0 && isTargetBranch) {
      const log = await git(cmd, repo, [
        "rev-list",
        "--parents",
        from,
        "--not",
        `origin/${base}`,
      ]);
      if (log.exitCode === 0) {
        const missing = new Set<string>();
        const merges: { sha: string; parents: string[] }[] = [];
        for (const line of log.stdout.split("\n").filter(Boolean)) {
          const [sha, ...parents] = line.split(" ");
          if (!sha) continue;
          missing.add(sha);
          if (parents.length > 1) merges.push({ sha, parents });
        }
        const { exempt, tips } = await exemptShasInRepo(
          deps,
          repo,
          args,
          from,
        );
        // A merge commit by `bb orchestrator merge` is exempt even
        // when its `merged_sha` was not recorded: a parent that is a
        // task tip proves it landed task work.
        for (const m of merges) {
          if (m.parents.some((p) => tips.has(p))) exempt.add(m.sha);
        }
        for (const s of exempt) missing.delete(s);
        if (missing.size > 0) {
          return {
            refuse:
              `from-unpublished: ${missing.size} коммитов не в ` +
              `origin/${base} и не из этой задачи`,
          };
        }
      }
      // A rev-list error proves nothing — the explicit `--from` passes,
      // as it did before the gate existed.
    }
  }

  return { kind: "named", name: `origin/${base}` };
}
