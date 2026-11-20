// plugins/bb-plugin-orchestrator/src/route-limits.ts
// Machine verification of route boundaries for fix and simple tasks
// Spec: docs/specs/orchestrator.md §31.7, Б3, r34.2

import type { CmdRunner } from "./cmd.js";
import type { TaskQueueRow } from "./store.js";
import type { RouteLimitsConfig } from "./policy.js";
import { globMatch } from "./commands.js";

export const DEFAULT_SPEC_PATHS = ["docs/specs/**", "docs/adr/**"];
export const DEFAULT_MIGRATION_PATHS = ["migrations/**", "schema.sql", "**/*.sql"];
export const DEFAULT_API_PATHS = ["src/api/**", "src/cli/**"];
export const DEFAULT_MAX_FILES = 3;
export const DEFAULT_MAX_LINES = 150;

export const TEST_PATTERNS = [
  "tests/**",
  "**/tests/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/__tests__/**",
];

export function isTestFile(filePath: string): boolean {
  if (filePath.startsWith("docs/specs/acceptance/")) {
    return true;
  }
  return TEST_PATTERNS.some((pat) => globMatch(pat, filePath));
}

export interface RouteLimitsCheckResult {
  violated: boolean;
  reason?: string;
  filesCount?: number;
  linesCount?: number;
  touchedProtected?: string[];
}

export async function checkRouteLimits(
  deps: { cmd?: CmdRunner; repoRoot?: string },
  task: TaskQueueRow,
  resultSha: string,
  routeLimits?: RouteLimitsConfig,
): Promise<RouteLimitsCheckResult> {
  if (task.route !== "fix" && task.route !== "simple") {
    return { violated: false };
  }
  if (!deps.cmd || !deps.repoRoot || !resultSha) {
    return { violated: false };
  }

  const baseRef =
    task.acceptance_sha ||
    (task.branch ? `refs/heads/${task.branch}` : "HEAD");

  let diffRes = await deps.cmd.run(
    "git",
    ["diff", "--name-only", `${baseRef}...${resultSha}`],
    { cwd: deps.repoRoot },
  );
  if (diffRes.exitCode !== 0) {
    diffRes = await deps.cmd.run(
      "git",
      ["diff", "--name-only", `${baseRef}..${resultSha}`],
      { cwd: deps.repoRoot },
    );
  }
  if (diffRes.exitCode !== 0) {
    diffRes = await deps.cmd.run(
      "git",
      ["diff", "--name-only", `${resultSha}~1`, resultSha],
      { cwd: deps.repoRoot },
    );
  }
  if (diffRes.exitCode !== 0) {
    return { violated: false };
  }

  const files = diffRes.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  if (files.length === 0) {
    return { violated: false };
  }

  const specPatterns = routeLimits?.specPaths ?? DEFAULT_SPEC_PATHS;
  const migrationPatterns = routeLimits?.migrationPaths ?? DEFAULT_MIGRATION_PATHS;
  const apiPatterns = routeLimits?.apiPaths ?? DEFAULT_API_PATHS;
  const maxFiles = routeLimits?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxLines = routeLimits?.maxLines ?? DEFAULT_MAX_LINES;

  const touchedProtected: string[] = [];

  for (const f of files) {
    // Acceptance contract itself is excluded from protected path check
    if (f.startsWith("docs/specs/acceptance/")) {
      continue;
    }
    if (specPatterns.some((pat) => globMatch(pat, f))) {
      touchedProtected.push(`spec:${f}`);
    } else if (migrationPatterns.some((pat) => globMatch(pat, f))) {
      touchedProtected.push(`migration:${f}`);
    } else if (apiPatterns.some((pat) => globMatch(pat, f))) {
      touchedProtected.push(`api:${f}`);
    }
  }

  if (touchedProtected.length > 0) {
    return {
      violated: true,
      reason: `route-violation: fix/simple task touched protected paths: ${touchedProtected.join(", ")}`,
      touchedProtected,
    };
  }

  // Filter out test files from volume calculation (§31.7)
  const codeFiles = files.filter((f) => !isTestFile(f));
  if (codeFiles.length > maxFiles) {
    return {
      violated: true,
      reason: `route-violation: fix/simple task exceeded file limit (${codeFiles.length} > ${maxFiles})`,
      filesCount: codeFiles.length,
    };
  }

  if (codeFiles.length > 0) {
    let numstatRes = await deps.cmd.run(
      "git",
      ["diff", "--numstat", `${baseRef}...${resultSha}`, "--", ...codeFiles],
      { cwd: deps.repoRoot },
    );
    if (numstatRes.exitCode !== 0) {
      numstatRes = await deps.cmd.run(
        "git",
        ["diff", "--numstat", `${baseRef}..${resultSha}`, "--", ...codeFiles],
        { cwd: deps.repoRoot },
      );
    }
    if (numstatRes.exitCode === 0) {
      let lines = 0;
      for (const line of numstatRes.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const added = parseInt(parts[0]!, 10);
          const deleted = parseInt(parts[1]!, 10);
          if (!isNaN(added)) lines += added;
          if (!isNaN(deleted)) lines += deleted;
        }
      }
      if (lines > maxLines) {
        return {
          violated: true,
          reason: `route-violation: fix/simple task exceeded line limit (${lines} > ${maxLines})`,
          linesCount: lines,
        };
      }
    }
  }

  return { violated: false };
}
