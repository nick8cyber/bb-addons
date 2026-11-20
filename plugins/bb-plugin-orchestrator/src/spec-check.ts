// plugins/bb-plugin-orchestrator/src/spec-check.ts
// Machine verification of spec codebase references before review
// Spec: docs/specs/orchestrator.md §31.6, Б7, r34.2

import type { CmdRunner } from "./cmd.js";
import type { TaskQueueRow } from "./store.js";

export interface SpecReferenceCheckResult {
  valid: boolean;
  notRun?: boolean;
  reason?: string;
  missingReferences?: string[];
}

const COMMON_KEYWORDS = new Set([
  "npm", "test", "run", "true", "false", "null", "undefined", "git", "bash",
  "json", "string", "number", "boolean", "any", "void", "return", "const",
  "let", "var", "import", "export", "function", "class", "interface", "type",
  "extends", "implements", "if", "else", "for", "while", "switch", "case",
  "break", "continue", "default", "async", "await", "new", "this", "super",
  "throw", "try", "catch", "finally", "in", "of", "typeof", "instanceof",
  "delete", "yield", "from", "as", "readonly", "public", "private", "protected",
  "static", "abstract", "override", "declare", "module", "namespace", "enum",
  "keyof", "infer", "is", "never", "unknown", "symbol", "unique", "bigint",
  "object", "global", "process", "console", "buffer", "promise", "array",
  "set", "map", "error", "regexp", "date", "math", "nan", "infinity",
  "strict", "auto", "manual", "shadow", "off", "running", "stalled", "blocked",
  "deferred", "done", "queued", "start", "design", "spec", "code", "checks",
  "review", "release", "research", "architect", "executor", "auditor",
  "researcher", "coordinator", "feature", "fix", "simple", "docs",
  "pre_code", "pre_release", "head", "origin", "main", "master",
  "ok", "changes", "verdict", "blockers", "target", "reason", "node", "status",
]);

export function parseSpecEntities(content: string): {
  declaredNew: Set<string>;
  referencedPaths: Set<string>;
  referencedSymbols: Set<string>;
} {
  const declaredNew = new Set<string>();
  const referencedPaths = new Set<string>();
  const referencedSymbols = new Set<string>();

  const lines = content.split("\n");
  let inNewEntitiesSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for section header
    if (/^##+\s+(?:новые\s+сущности|new\s+entities)/i.test(trimmed)) {
      inNewEntitiesSection = true;
      continue;
    } else if (/^##+\s+/.test(trimmed)) {
      inNewEntitiesSection = false;
    }

    // Extract backticked tokens: `foo/bar.ts` or `myFunction`
    const backtickMatches = line.matchAll(/`([^`]+)`/g);
    for (const match of backtickMatches) {
      const token = match[1]!.trim();
      if (!token || token.length < 2) continue;

      // Check if marked with [new]
      const hasNewTag =
        inNewEntitiesSection ||
        line.toLowerCase().includes("[new]") ||
        token.toLowerCase().includes("[new]");

      const cleanToken = token.replace(/\[new\]/gi, "").trim();
      if (!cleanToken) continue;

      if (hasNewTag) {
        declaredNew.add(cleanToken);
        continue;
      }

      // Is it a file path?
      if (
        cleanToken.includes("/") &&
        /\.(?:[tj]sx?|json|sql|md|ya?ml|py|go|rs|c|h|css|html|svg)$/i.test(cleanToken)
      ) {
        referencedPaths.add(cleanToken);
      } else if (/^[a-zA-Z_$][a-zA-Z0-9_$]{2,}$/.test(cleanToken)) {
        if (!COMMON_KEYWORDS.has(cleanToken.toLowerCase())) {
          referencedSymbols.add(cleanToken);
        }
      }
    }
  }

  return { declaredNew, referencedPaths, referencedSymbols };
}

export async function verifySpecReferences(
  deps: { cmd?: CmdRunner; repoRoot?: string },
  task: TaskQueueRow,
  specSha: string,
  mergeBaseBranch: string,
): Promise<SpecReferenceCheckResult> {
  if (!deps.cmd || !deps.repoRoot || !specSha) {
    return { valid: false, notRun: true, reason: "missing cmd runner or repoRoot" };
  }

  // Get diff of added lines in docs/ (-U0 gives zero context lines)
  let diffRes = await deps.cmd.run(
    "git",
    ["diff", "-U0", `${mergeBaseBranch}...${specSha}`, "--", "docs/"],
    { cwd: deps.repoRoot },
  );
  if (diffRes.exitCode !== 0) {
    diffRes = await deps.cmd.run(
      "git",
      ["diff", "-U0", `${specSha}~1`, specSha, "--", "docs/"],
      { cwd: deps.repoRoot },
    );
  }
  if (diffRes.exitCode !== 0) {
    return {
      valid: false,
      notRun: true,
      reason: `spec-not-run: git diff failed: ${diffRes.stderr || diffRes.stdout}`,
    };
  }

  // Extract only added lines (starts with '+' and not '+++')
  const addedLines = diffRes.stdout
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));

  if (addedLines.length === 0) {
    // If no docs lines were added, nothing to verify
    return { valid: true };
  }

  const addedContent = addedLines.join("\n");
  const { declaredNew, referencedPaths, referencedSymbols } = parseSpecEntities(addedContent);

  const missing: string[] = [];

  // Check file paths against base commit
  for (const p of referencedPaths) {
    if (declaredNew.has(p)) continue;
    // Check if file exists on mergeBaseBranch
    const catRes = await deps.cmd.run(
      "git",
      ["cat-file", "-e", `${mergeBaseBranch}:${p}`],
      { cwd: deps.repoRoot },
    );
    if (catRes.exitCode !== 0) {
      missing.push(`file:${p}`);
    }
  }

  // Check symbols against base commit codebase (text search without AST/package.json)
  for (const sym of referencedSymbols) {
    if (declaredNew.has(sym)) continue;
    // Search codebase on base commit for symbol (excluding docs/)
    const grepRes = await deps.cmd.run(
      "git",
      ["grep", "-q", "-w", "-F", sym, mergeBaseBranch, "--", ":(exclude)docs"],
      { cwd: deps.repoRoot },
    );
    if (grepRes.exitCode !== 0) {
      // Try without word-boundary
      const grepRes2 = await deps.cmd.run(
        "git",
        ["grep", "-q", "-F", sym, mergeBaseBranch, "--", ":(exclude)docs"],
        { cwd: deps.repoRoot },
      );
      if (grepRes2.exitCode !== 0) {
        missing.push(`symbol:${sym}`);
      }
    }
  }

  if (missing.length > 0) {
    return {
      valid: false,
      notRun: false,
      missingReferences: missing,
      reason: `spec-refused: invalid-codebase-reference: непомеченные несуществующие файлы или символы: ${missing.join(", ")}`,
    };
  }

  return { valid: true };
}
