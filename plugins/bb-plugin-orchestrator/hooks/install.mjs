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
import { dirname, isAbsolute, join, resolve } from "node:path";
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
const selfTest = args.includes("--self-test");
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
const MAX_DEPTH = 8;

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
    if (!e.isDirectory() || SKIP.has(e.name)) continue;
    // §7 опись: thread worktrees live under ~/.bb/plugins/environment-
    // git-worktree/... — hidden dirs are skipped EXCEPT .bb itself.
    if (e.name.startsWith(".") && e.name !== ".bb") continue;
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
  "",
  "проекты с excluded:true в настройке release: их репозитории хук не трогает —",
  "добавьте пути через --exclude <path> (или запишите в exclusions вручную).",
].join("\n");

if (dryRun) {
  console.log(report);
  process.exit(0);
}

// §5/§7 self-test: build each repository kind in a temp dir and prove a
// local pre-push hook still fires through the shared one (with a valid
// release token on a matching sha).
if (selfTest) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const tmp = mkdtempSync(join(tmpdir(), "hook-selftest-"));
  // Run against a TEMP copy of the hooks dir — the token file resolves
  // relative to the hook's own directory, so the live push-token.json
  // (possibly written by an in-flight release) is never touched.
  const testHooksDir = join(tmp, "hooks");
  mkdirSync(testHooksDir, { recursive: true });
  const hookPath = join(testHooksDir, "pre-push");
  copyFileSync(
    existsSync(join(hooksDir, "pre-push"))
      ? join(hooksDir, "pre-push")
      : join(dirname(fileURLToPath(import.meta.url)), "pre-push"),
    hookPath,
  );
  execFileSync("chmod", ["755", hookPath]);
  const SHA = "a".repeat(40);
  const LINE = `refs/heads/x ${SHA} refs/heads/x ${"0".repeat(40)}\n`;
  const kinds = [
    { name: "plain .git/hooks", mk: (r) => r },
    {
      name: "worktree (.git file)",
      mk: (r) => {
        execFileSync("git", ["-C", r, "worktree", "add", join(tmp, "wt")], { stdio: "ignore" });
        return join(tmp, "wt");
      },
    },
  ];
  let failed = 0;
  for (const kind of kinds) {
    const base = join(tmp, kind.name.replace(/\W+/g, "-"));
    execFileSync("git", ["init", base], { stdio: "ignore" });
    const repo = kind.mk(base);
    // local hook writes a marker next to the repo when it fires
    const commonRaw = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
    const common = isAbsolute(commonRaw) ? commonRaw : join(repo, commonRaw);
    const lh = join(common, "hooks", "pre-push");
    writeFileSync(lh, '#!/bin/sh\n[ -n "$ORCH_MARK" ] && echo hit > "$ORCH_MARK"\nexit 0\n');
    execFileSync("chmod", ["+x", lh]);
    writeFileSync(join(testHooksDir, "push-token.json"),
      JSON.stringify({ token: "t", sha: SHA, expiresAt: Date.now() + 60000 }));
    const mark = join(tmp, `mark-${kind.name.replace(/\W+/g, "-")}`);
    const r = spawnSync("node", [hookPath], {
      cwd: repo, input: LINE,
      env: { ...process.env, GIT_DIR: execFileSync("git", ["-C", repo, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim(), ORCH_MARK: mark },
      encoding: "utf8",
    });
    const ok = r.status === 0 && existsSync(mark);
    console.log(`${ok ? "OK " : "FAIL"}  local hook fires: ${kind.name}`);
    if (!ok) failed++;
  }
  rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
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
