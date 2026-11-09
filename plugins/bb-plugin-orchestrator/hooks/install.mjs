#!/usr/bin/env node
/**
 * Installer for the shared pre-push hook (spec orchestrator-release §7).
 * Run once per development user — NOT during tests:
 *
 *   node plugins/bb-plugin-orchestrator/hooks/install.mjs [--dry-run]
 *     [--hooks-dir <dir>] [--repos-root <dir>] [--exclude <path>]...
 *
 * 1. Inventory (опись) of the user's repositories: which hooks live in
 *    `.git/hooks`, which have their own `core.hooksPath` («свой процесс» —
 *    the shared hook never reaches them), which are excluded (service
 *    repos with autopush — put them in `--exclude`, else their autopush
 *    breaks).
 * 2. Copies `pre-push` into the hooks dir and writes `exclusions`.
 * 3. Sets `git config --global core.hooksPath <hooks dir>` unless one is
 *    already configured (then it only reports — `--force` overrides).
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const multi = (n) => {
  const out = [];
  args.forEach((a, i) => a === n && out.push(args[i + 1]));
  return out;
};
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const hooksDir = resolve(
  flag("--hooks-dir") ??
    join(homedir(), ".bb", "plugins", "orchestrator", "git-hooks"),
);
const reposRoot = resolve(flag("--repos-root") ?? homedir());
const extraExcludes = multi("--exclude").map((p) => resolve(p));

const SKIP = new Set([
  "node_modules", ".cache", ".local", ".npm", ".cargo", ".rustup",
  "snap", ".vscode", ".config/google-chrome",
]);
const MAX_DEPTH = 4;

function* findRepos(root, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (existsSync(join(root, ".git"))) {
    yield root;
    return; // do not descend into a repo's own tree
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
    yield* findRepos(join(root, e.name), depth + 1);
  }
}

function gitConfig(repo, key) {
  try {
    return execFileSync("git", ["-C", repo, "config", "--local", key], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

// ── Inventory ──────────────────────────────────────────────────────────
const repos = [...findRepos(reposRoot)];
const ownHooksPath = [];
const withLocalHooks = [];
const plain = [];
for (const repo of repos) {
  if (gitConfig(repo, "core.hooksPath")) {
    ownHooksPath.push(repo);
    continue;
  }
  const hooksDirLocal = join(repo, ".git", "hooks");
  let hasLocal = false;
  try {
    hasLocal =
      existsSync(hooksDirLocal) &&
      readdirSync(hooksDirLocal).some(
        (f) =>
          !f.endsWith(".sample") &&
          statSync(join(hooksDirLocal, f)).mode & 0o111,
      );
  } catch { /* not a plain checkout (worktree .git file) */ }
  (hasLocal ? withLocalHooks : plain).push(repo);
}

const exclusions = [...new Set(extraExcludes)];

const report = [
  `hooks dir:      ${hooksDir}`,
  `repos root:     ${reposRoot} (${repos.length} репозиториев)`,
  "",
  `свой core.hooksPath (общий хук их НЕ трогает): ${ownHooksPath.length}`,
  ...ownHooksPath.map((r) => `  - ${r}`),
  `с локальными .git/hooks (будут вызваны общим хуком): ${withLocalHooks.length}`,
  ...withLocalHooks.map((r) => `  - ${r}`),
  `без локальных хуков: ${plain.length}`,
  ...plain.map((r) => `  - ${r}`),
  `исключения (автопуш служебных): ${exclusions.length}`,
  ...exclusions.map((r) => `  - ${r}`),
].join("\n");

if (dryRun) {
  console.log(report);
  process.exit(0);
}

// ── Install ────────────────────────────────────────────────────────────
mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
copyFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "pre-push"),
  join(hooksDir, "pre-push"),
);
execFileSync("chmod", ["755", join(hooksDir, "pre-push")]);
writeFileSync(
  join(hooksDir, "exclusions"),
  exclusions.map((e) => `${e}\n`).join(""),
);

let hooksPathNow = "";
try {
  hooksPathNow = execFileSync(
    "git",
    ["config", "--global", "core.hooksPath"],
    { encoding: "utf8" },
  ).trim();
} catch { /* unset */ }

if (hooksPathNow && resolve(hooksPathNow) !== hooksDir && !force) {
  console.log(report);
  console.log(
    `\n!! глобальный core.hooksPath уже задан: ${hooksPathNow}\n` +
      `   не переписываю; для замены запустите с --force`,
  );
  process.exit(1);
}
execFileSync("git", ["config", "--global", "core.hooksPath", hooksDir]);
console.log(report);
console.log(`\nустановлено: core.hooksPath → ${hooksDir}`);
